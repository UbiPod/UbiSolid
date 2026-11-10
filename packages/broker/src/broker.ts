import { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open, seal } from './crypto';
import type { KeyWrapper } from './crypto';
import { InvalidGrantError } from './providers';
import type { Provider, ProviderName, TokenSet } from './providers';

export class BrokerError extends Error {
  public constructor(public readonly status: number, message: string, public readonly retryAfter?: number) {
    super(message);
  }
}

export interface LinkRow {
  link_id: string;
  provider: ProviderName;
  provider_account_id: string;
  account_email: string | null;
  account_id: string;
  /** pending and revoking: tenant mode, waiting for the provisioning job. */
  status: 'active' | 'revoked' | 'pending' | 'revoking';
  created_at: number;
  last_refreshed_at: number | null;
  version: number;
  wrapped_dek: string | null;
  sealed_refresh: string | null;
  /** stored: the broker keeps the refresh token. session: private mode, the owner's browser does. */
  mode: LinkMode;
  /** Tenant mode: JSON { driveId, folderId, permissionId } once provisioned. */
  location: string | null;
}

/** stored: the broker keeps the refresh token. session: private mode. tenant: app-only, per-folder grants. */
export type LinkMode = 'stored' | 'session' | 'tenant';

export interface TenantLocation {
  driveId: string;
  folderId: string;
  permissionId?: string;
}

export interface PublicLink {
  linkId: string;
  provider: ProviderName;
  email?: string;
  status: string;
  createdAt: string;
  lastRefreshedAt?: string;
  pods: string[];
  mode: LinkMode;
  /** Private mode: until when the owner's browser has given us a token. */
  onlineUntil?: string;
}

export interface IssuedToken {
  accessToken: string;
  expiresAt: number;
  provider: ProviderName;
  root: string;
  location?: Record<string, string>;
}

const PENDING_TTL_MS = 10 * 60_000;
/** Private mode: a pushed token with less left than this counts as offline. */
const SESSION_MIN_LEFT_MS = 60_000;
/** Private mode: never trust a pushed expiry further out than this. */
const SESSION_MAX_MS = 2 * 3600_000;
const EARLY_REFRESH_MS = 5 * 60_000;

export interface BrokerOptions {
  /** Max token issuances (cache hits included) per link per hour. */
  issueLimitPerHour?: number;
  /** Refresh Google links idle for longer than this so their refresh token doesn't age out. */
  keepWarmAfterMs?: number;
  now?: () => number;
}

export class Broker {
  private readonly db: Database;
  /** Access tokens live only here, never on disk. */
  private readonly cache = new Map<string, { accessToken: string; expiresAt: number }>();
  /** One refresh in flight per link. */
  private readonly inflight = new Map<string, Promise<{ accessToken: string; expiresAt: number }>>();
  private readonly issued = new Map<string, number[]>();
  private readonly issueLimit: number;
  private readonly keepWarmAfterMs: number;
  private readonly now: () => number;

  public constructor(
    dbPath: string,
    private readonly keys: KeyWrapper,
    private readonly providers: Map<ProviderName, Provider>,
    private readonly redirectUri: string,
    options: BrokerOptions = {},
  ) {
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        link_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        account_email TEXT,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_refreshed_at INTEGER,
        version INTEGER NOT NULL DEFAULT 0,
        wrapped_dek TEXT,
        sealed_refresh TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS links_owner ON links (account_id, provider, provider_account_id);
      CREATE TABLE IF NOT EXISTS pods (
        pod_base TEXT PRIMARY KEY,
        link_id TEXT NOT NULL REFERENCES links(link_id),
        root TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending (
        state TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        verifier TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const columns = (this.db.query('PRAGMA table_info(links)').all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('mode')) {
      this.db.exec(`ALTER TABLE links ADD COLUMN mode TEXT NOT NULL DEFAULT 'stored'`);
    }
    if (!columns.includes('location')) {
      this.db.exec('ALTER TABLE links ADD COLUMN location TEXT');
    }
    this.issueLimit = options.issueLimitPerHour ?? 120;
    this.keepWarmAfterMs = options.keepWarmAfterMs ?? 30 * 24 * 3600_000;
    this.now = options.now ?? Date.now;
  }

  public providerNames(): ProviderName[] {
    return [ ...this.providers.keys() ];
  }

  /** Providers that support private mode. */
  public sessionProviderNames(): ProviderName[] {
    return [ ...this.providers.values() ].filter((p) => p.session).map((p) => p.name);
  }

  private provider(name: string): Provider {
    const provider = this.providers.get(name as ProviderName);
    if (!provider) {
      throw new BrokerError(400, `Unknown or unconfigured provider: ${name}`);
    }
    return provider;
  }

  // ---------------------------------------------------------------- linking

  public createLink(provider: string, accountId: string, loginHint?: string): { authorizeUrl: string } {
    const p = this.provider(provider);
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.db.query('DELETE FROM pending WHERE created_at < ?').run(this.now() - PENDING_TTL_MS);
    this.db.query('INSERT INTO pending (state, provider, account_id, verifier, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(state, p.name, accountId, verifier, this.now());
    return { authorizeUrl: p.authorizeUrl({ state, challenge, redirectUri: this.redirectUri, loginHint }) };
  }

  /**
   * Finishes a link. `accountId` is the CSS account of the browser session that landed on the callback.
   * It has to match the account that started the link, so nobody can attach their storage to someone else's
   * account (or someone else's storage to theirs) by sending them a callback URL.
   */
  public async completeLink(code: string, state: string, accountId: string): Promise<PublicLink> {
    const pending = this.db.query('SELECT * FROM pending WHERE state = ?').get(state) as
      { provider: string; account_id: string; verifier: string; created_at: number } | null;
    // Single use, whatever happens next.
    this.db.query('DELETE FROM pending WHERE state = ?').run(state);
    if (!pending || pending.created_at < this.now() - PENDING_TTL_MS) {
      throw new BrokerError(400, 'This link request expired or was already used. Start again.');
    }
    if (pending.account_id !== accountId) {
      throw new BrokerError(403, 'This link was started by a different account.');
    }
    const p = this.provider(pending.provider);
    let tokens: TokenSet;
    try {
      tokens = await p.exchange(code, pending.verifier, this.redirectUri);
    } catch (error) {
      throw new BrokerError(502, `The provider refused the authorization code: ${(error as Error).message}`);
    }
    if (p.tenant) {
      return this.completeTenantLink(p, tokens, accountId);
    }
    if (!tokens.refreshToken) {
      throw new BrokerError(502, 'The provider did not issue a refresh token.');
    }
    const who = await p.identify(tokens);

    // Relinking the same provider account replaces the old grant in place (Google caps live refresh tokens).
    const existing = this.db.query(`SELECT * FROM links WHERE account_id = ? AND provider = ? AND provider_account_id = ?
        AND mode = 'stored'`).get(accountId, p.name, who.id) as LinkRow | null;
    const linkId = existing?.link_id ?? randomUUID();
    const dek = randomBytes(32);
    const wrapped = await this.keys.wrap(dek);
    const sealed = seal(dek, Buffer.from(tokens.refreshToken), linkId);
    const now = this.now();
    if (existing) {
      this.db.query(`UPDATE links SET status = 'active', account_email = ?, wrapped_dek = ?, sealed_refresh = ?,
          last_refreshed_at = ?, version = version + 1 WHERE link_id = ?`)
        .run(who.email ?? null, wrapped, sealed, now, linkId);
    } else {
      this.db.query(`INSERT INTO links (link_id, provider, provider_account_id, account_email, account_id, status,
          created_at, last_refreshed_at, version, wrapped_dek, sealed_refresh) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?)`)
        .run(linkId, p.name, who.id, who.email ?? null, accountId, now, now, wrapped, sealed);
    }
    this.cache.set(linkId, { accessToken: tokens.accessToken, expiresAt: now + tokens.expiresIn * 1000 });
    return this.publicLink(this.row(linkId)!);
  }

  /**
   * Tenant mode: the sign-in only proved who the user is. Their tokens are dropped here; the link waits
   * for the provisioning job to create their folder and grant the broker's app a role on it.
   */
  private async completeTenantLink(p: Provider, tokens: TokenSet, accountId: string): Promise<PublicLink> {
    let who;
    try {
      who = await p.identify(tokens);
    } catch (error) {
      throw new BrokerError(403, (error as Error).message);
    }
    const existing = this.db.query(`SELECT * FROM links WHERE account_id = ? AND provider = ? AND provider_account_id = ?
        AND mode = 'tenant'`).get(accountId, p.name, who.id) as LinkRow | null;
    const now = this.now();
    if (!existing) {
      const linkId = randomUUID();
      this.db.query(`INSERT INTO links (link_id, provider, provider_account_id, account_email, account_id, status,
          created_at, version, mode) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, 'tenant')`)
        .run(linkId, p.name, who.id, who.email ?? null, accountId, now);
      return this.publicLink(this.row(linkId)!);
    }
    if (existing.status === 'revoked') {
      this.db.query(`UPDATE links SET status = 'pending', version = version + 1 WHERE link_id = ?`).run(existing.link_id);
    }
    return this.publicLink(this.row(existing.link_id)!);
  }

  // ---------------------------------------------------------------- tokens

  private row(linkId: string): LinkRow | null {
    return this.db.query('SELECT * FROM links WHERE link_id = ?').get(linkId) as LinkRow | null;
  }

  private countIssue(linkId: string): void {
    const cutoff = this.now() - 3600_000;
    const times = (this.issued.get(linkId) ?? []).filter((t) => t > cutoff);
    if (times.length >= this.issueLimit) {
      this.issued.set(linkId, times);
      throw new BrokerError(429, 'Token issuance limit reached for this link.', 60);
    }
    times.push(this.now());
    this.issued.set(linkId, times);
  }

  public async token(linkId: string, podBase: string): Promise<IssuedToken> {
    const pod = this.db.query('SELECT * FROM pods WHERE pod_base = ?').get(podBase) as
      { link_id: string; root: string } | null;
    if (!pod || pod.link_id !== linkId) {
      throw new BrokerError(403, 'That pod is not bound to that link.');
    }
    const row = this.row(linkId);
    if (!row || row.status !== 'active') {
      throw new BrokerError(410, 'Storage for this pod is disconnected.');
    }
    this.countIssue(linkId);
    if (row.mode === 'tenant') {
      const location = JSON.parse(row.location ?? '{}') as TenantLocation;
      const { accessToken, expiresAt } = await this.appToken(row.provider);
      return { accessToken, expiresAt, provider: row.provider, root: pod.root,
        location: { driveId: location.driveId, folderId: location.folderId }};
    }
    if (row.mode === 'session') {
      const pushed = this.cache.get(linkId);
      if (!pushed || pushed.expiresAt - SESSION_MIN_LEFT_MS <= this.now()) {
        throw new BrokerError(503, 'This pod is in private mode and its owner is not connected right now.');
      }
      return { ...pushed, provider: row.provider, root: pod.root };
    }
    const { accessToken, expiresAt } = await this.accessToken(row);
    return { accessToken, expiresAt, provider: row.provider, root: pod.root };
  }

  private async accessToken(row: LinkRow): Promise<{ accessToken: string; expiresAt: number }> {
    const cached = this.cache.get(row.link_id);
    if (cached && cached.expiresAt - EARLY_REFRESH_MS > this.now()) {
      return cached;
    }
    let pending = this.inflight.get(row.link_id);
    if (!pending) {
      pending = this.refresh(row.link_id).finally(() => this.inflight.delete(row.link_id));
      this.inflight.set(row.link_id, pending);
    }
    return pending;
  }

  /** The only place a refresh token is ever decrypted. */
  private async refresh(linkId: string): Promise<{ accessToken: string; expiresAt: number }> {
    const row = this.row(linkId);
    if (!row || row.status !== 'active' || !row.wrapped_dek || !row.sealed_refresh) {
      throw new BrokerError(410, 'Storage for this pod is disconnected.');
    }
    const dek = await this.keys.unwrap(row.wrapped_dek);
    const refreshToken = open(dek, row.sealed_refresh, linkId).toString('utf8');
    let tokens: TokenSet;
    try {
      tokens = await this.provider(row.provider).refresh(refreshToken);
    } catch (error) {
      if (error instanceof InvalidGrantError) {
        this.db.query(`UPDATE links SET status = 'revoked', version = version + 1 WHERE link_id = ?`).run(linkId);
        this.cache.delete(linkId);
        throw new BrokerError(410, 'The storage provider no longer accepts this link. Reconnect it.');
      }
      throw new BrokerError(503, `Refreshing at the provider failed: ${(error as Error).message}`, 30);
    } finally {
      dek.fill(0);
    }
    const now = this.now();
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      // Rotation: persist the new refresh token before releasing the access token.
      // Compare-and-swap on version, so a concurrent relink or unlink wins over us.
      const freshDek = randomBytes(32);
      const wrapped = await this.keys.wrap(freshDek);
      const sealed = seal(freshDek, Buffer.from(tokens.refreshToken), linkId);
      freshDek.fill(0);
      const result = this.db.query(`UPDATE links SET wrapped_dek = ?, sealed_refresh = ?, last_refreshed_at = ?,
          version = version + 1 WHERE link_id = ? AND version = ? AND status = 'active'`)
        .run(wrapped, sealed, now, linkId, row.version);
      if (result.changes !== 1) {
        throw new BrokerError(503, 'The link changed while refreshing; try again.', 1);
      }
    } else {
      this.db.query('UPDATE links SET last_refreshed_at = ? WHERE link_id = ?').run(now, linkId);
    }
    const fresh = { accessToken: tokens.accessToken, expiresAt: now + tokens.expiresIn * 1000 };
    this.cache.set(linkId, fresh);
    return fresh;
  }

  /** Tenant mode: the broker app's own token, shared by every tenant link, in memory only. */
  private async appToken(provider: ProviderName): Promise<{ accessToken: string; expiresAt: number }> {
    const key = `app:${provider}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - EARLY_REFRESH_MS > this.now()) {
      return cached;
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = (async() => {
        try {
          const tokens = await this.provider(provider).tenant!.appToken();
          const fresh = { accessToken: tokens.accessToken, expiresAt: this.now() + tokens.expiresIn * 1000 };
          this.cache.set(key, fresh);
          return fresh;
        } catch (error) {
          throw new BrokerError(503, `Getting the app token failed: ${(error as Error).message}`, 30);
        }
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  // ---------------------------------------------------------------- tenant provisioning

  /**
   * Work for the provisioning job, which runs separately with its own key and its own admin credential.
   * provision: create the user's folder and grant the broker's app on it. deprovision: remove that grant.
   */
  public tenantQueue(): { provision: object[]; deprovision: object[] } {
    const rows = this.db.query(`SELECT * FROM links WHERE mode = 'tenant' AND status IN ('pending', 'revoking')`).all() as LinkRow[];
    return {
      provision: rows.filter((r) => r.status === 'pending')
        .map((r) => ({ linkId: r.link_id, provider: r.provider, userId: r.provider_account_id, email: r.account_email })),
      deprovision: rows.filter((r) => r.status === 'revoking')
        .map((r) => ({ linkId: r.link_id, provider: r.provider, userId: r.provider_account_id, location: JSON.parse(r.location ?? '{}') })),
    };
  }

  /** The job created the folder and the grant. The link goes live only if the broker's app can really reach it. */
  public async tenantActivate(linkId: string, location: TenantLocation): Promise<PublicLink> {
    const row = this.row(linkId);
    if (!row || row.mode !== 'tenant' || row.status !== 'pending') {
      throw new BrokerError(409, 'That link is not waiting to be provisioned.');
    }
    const { accessToken } = await this.appToken(row.provider);
    try {
      await this.provider(row.provider).tenant!.checkAccess(accessToken, location);
    } catch (error) {
      throw new BrokerError(409, (error as Error).message);
    }
    this.db.query(`UPDATE links SET status = 'active', location = ?, last_refreshed_at = ?, version = version + 1
        WHERE link_id = ? AND status = 'pending'`).run(JSON.stringify(location), this.now(), linkId);
    return this.publicLink(this.row(linkId)!);
  }

  /** The job removed the grant. */
  public tenantRevoked(linkId: string): void {
    const row = this.row(linkId);
    if (!row || row.mode !== 'tenant' || row.status !== 'revoking') {
      throw new BrokerError(409, 'That link is not waiting to be deprovisioned.');
    }
    this.db.query(`UPDATE links SET status = 'revoked', location = NULL, version = version + 1 WHERE link_id = ?`).run(linkId);
  }

  /** Refresh Google links that have been idle long enough to risk the 6-month inactivity expiry. */
  public async keepWarm(): Promise<number> {
    const rows = this.db.query(`SELECT * FROM links WHERE status = 'active' AND provider = 'googledrive' AND mode = 'stored'
        AND COALESCE(last_refreshed_at, created_at) < ?`).all(this.now() - this.keepWarmAfterMs) as LinkRow[];
    let refreshed = 0;
    for (const row of rows) {
      try {
        this.cache.delete(row.link_id);
        await this.accessToken(row);
        refreshed += 1;
      } catch (error) {
        console.error(`keep-warm failed for ${row.link_id}: ${(error as Error).message}`);
      }
    }
    return refreshed;
  }

  // ---------------------------------------------------------------- private mode

  public sessionConfig(provider: string, redirectUri: string): ReturnType<NonNullable<Provider['session']>['config']> {
    const p = this.provider(provider);
    if (!p.session) {
      throw new BrokerError(400, `${provider} doesn't support private mode.`);
    }
    return p.session.config(redirectUri);
  }

  /**
   * Private mode: the owner's browser hands over an access token it got from the provider itself.
   * The provider tells us whose it is. The first push creates the link; later pushes keep it online.
   * Nothing is written to disk except the link's metadata.
   */
  public async pushSessionToken(accountId: string, provider: string, accessToken: string, expiresIn: number):
  Promise<PublicLink> {
    const p = this.provider(provider);
    if (!p.session) {
      throw new BrokerError(400, `${provider} doesn't support private mode.`);
    }
    let who;
    try {
      who = await p.session.identifyAccess(accessToken);
    } catch (error) {
      throw new BrokerError(400, `The provider didn't accept that token: ${(error as Error).message}`);
    }
    let row = this.db.query(`SELECT * FROM links WHERE account_id = ? AND provider = ? AND provider_account_id = ?
        AND mode = 'session'`).get(accountId, p.name, who.id) as LinkRow | null;
    const now = this.now();
    if (!row) {
      const linkId = randomUUID();
      this.db.query(`INSERT INTO links (link_id, provider, provider_account_id, account_email, account_id, status,
          created_at, last_refreshed_at, version, mode) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 0, 'session')`)
        .run(linkId, p.name, who.id, who.email ?? null, accountId, now, now);
      row = this.row(linkId)!;
    } else {
      this.db.query(`UPDATE links SET status = 'active', last_refreshed_at = ? WHERE link_id = ?`).run(now, row.link_id);
    }
    const lifetime = Math.min(Math.max(Number(expiresIn) || 0, 0) * 1000, SESSION_MAX_MS);
    this.cache.set(row.link_id, { accessToken, expiresAt: now + lifetime });
    return this.publicLink(this.row(row.link_id)!);
  }

  // ---------------------------------------------------------------- pods

  public bindPod(podBase: string, linkId: string, accountId: string): { podBase: string; root: string } {
    const row = this.row(linkId);
    if (!row || row.account_id !== accountId) {
      throw new BrokerError(404, 'No such link for this account.');
    }
    if (row.status !== 'active') {
      throw new BrokerError(409, 'That storage link is not active. Reconnect it first.');
    }
    const url = new URL(podBase);
    if (!url.pathname.endsWith('/')) {
      throw new BrokerError(400, 'podBase must end with a slash.');
    }
    // One folder per pod inside the provider's app folder.
    const segments = url.pathname.split('/').filter(Boolean);
    const name = segments.length > 0 ? segments.join('_') : url.hostname;
    const root = `/${name}`;
    const existing = this.db.query('SELECT link_id FROM pods WHERE pod_base = ?').get(podBase) as { link_id: string } | null;
    if (existing && existing.link_id !== linkId) {
      throw new BrokerError(409, 'That pod is already bound to other storage.');
    }
    this.db.query('INSERT OR REPLACE INTO pods (pod_base, link_id, root) VALUES (?, ?, ?)').run(podBase, linkId, root);
    return { podBase, root };
  }

  public unbindPod(podBase: string, accountId: string): void {
    this.db.query('DELETE FROM pods WHERE pod_base = ? AND link_id IN (SELECT link_id FROM links WHERE account_id = ?)')
      .run(podBase, accountId);
  }

  public pods(): { podBase: string; linkId: string }[] {
    return (this.db.query('SELECT pod_base, link_id FROM pods').all() as { pod_base: string; link_id: string }[])
      .map((r) => ({ podBase: r.pod_base, linkId: r.link_id }));
  }

  // ---------------------------------------------------------------- listing and unlinking

  private publicLink(row: LinkRow): PublicLink {
    const pods = (this.db.query('SELECT pod_base FROM pods WHERE link_id = ?').all(row.link_id) as { pod_base: string }[])
      .map((r) => r.pod_base);
    return {
      linkId: row.link_id,
      provider: row.provider,
      email: row.account_email ?? undefined,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      lastRefreshedAt: row.last_refreshed_at ? new Date(row.last_refreshed_at).toISOString() : undefined,
      pods,
      mode: row.mode,
      ...row.mode === 'session' ? { onlineUntil: this.onlineUntil(row.link_id) } : {},
    };
  }

  private onlineUntil(linkId: string): string | undefined {
    const pushed = this.cache.get(linkId);
    return pushed && pushed.expiresAt - SESSION_MIN_LEFT_MS > this.now() ?
      new Date(pushed.expiresAt - SESSION_MIN_LEFT_MS).toISOString() :
      undefined;
  }

  public links(accountId: string): PublicLink[] {
    return (this.db.query('SELECT * FROM links WHERE account_id = ? ORDER BY created_at').all(accountId) as LinkRow[])
      .map((row) => this.publicLink(row));
  }

  /**
   * Revoke at the provider, then crypto-shred. Pods stay bound, so they answer 503 instead of
   * silently falling back to an empty local pod. Their files stay in the owner's storage.
   */
  public async unlink(linkId: string, accountId: string): Promise<{ provider: string; revokedAtProvider: string }> {
    const row = this.row(linkId);
    if (!row || row.account_id !== accountId) {
      throw new BrokerError(404, 'No such link for this account.');
    }
    if (row.mode === 'tenant') {
      // Pods go offline at once; the provisioning job removes the folder grant.
      this.db.query(`UPDATE links SET status = CASE WHEN location IS NULL THEN 'revoked' ELSE 'revoking' END,
          version = version + 1 WHERE link_id = ?`).run(linkId);
      return { provider: row.provider, revokedAtProvider: row.location ? 'queued' : 'skipped' };
    }
    let revokedAtProvider = 'skipped';
    if (row.status === 'active' && row.wrapped_dek && row.sealed_refresh) {
      const dek = await this.keys.unwrap(row.wrapped_dek);
      const refreshToken = open(dek, row.sealed_refresh, linkId).toString('utf8');
      dek.fill(0);
      try {
        revokedAtProvider = await this.provider(row.provider).revoke(refreshToken, this.cache.get(linkId)?.accessToken);
      } catch (error) {
        throw new BrokerError(502, `Revoking at the provider failed, nothing was deleted: ${(error as Error).message}`);
      }
    }
    this.cache.delete(linkId);
    this.db.query(`UPDATE links SET status = 'revoked', wrapped_dek = NULL, sealed_refresh = NULL, version = version + 1
        WHERE link_id = ?`).run(linkId);
    return { provider: row.provider, revokedAtProvider };
  }

  public close(): void {
    this.db.close();
  }
}
