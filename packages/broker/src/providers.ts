import { randomBytes } from 'node:crypto';

export type ProviderName = 'onedrive' | 'dropbox' | 'googledrive' | 'fake';

export interface TokenSet {
  accessToken: string;
  /** Present when the provider issued (or rotated to) a new refresh token. */
  refreshToken?: string;
  expiresIn: number;
  idToken?: string;
}

export interface ProviderAccount {
  id: string;
  email?: string;
}

/** Thrown when the provider says the grant is dead (revoked, expired, password changed …). */
export class InvalidGrantError extends Error {}

export interface Provider {
  readonly name: ProviderName;
  authorizeUrl(args: { state: string; challenge: string; redirectUri: string; loginHint?: string }): string;
  exchange(code: string, verifier: string, redirectUri: string): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  identify(tokens: TokenSet): Promise<ProviderAccount>;
  /** Revoke the grant at the provider, if it supports that. */
  revoke(refreshToken: string, accessToken?: string): Promise<'revoked' | 'unsupported'>;
}

interface ClientConfig {
  clientId: string;
  clientSecret?: string;
}

function decodeJwtClaims(jwt?: string): Record<string, string> {
  if (!jwt) {
    return {};
  }
  // The ID token came straight from the provider's token endpoint over TLS, so its claims are trusted without
  // checking the signature (OpenID Connect Core 3.1.3.7, point 6).
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

async function tokenRequest(url: string, form: Record<string, string | undefined>): Promise<TokenSet> {
  const body = new URLSearchParams();
  for (const [ key, value ] of Object.entries(form)) {
    if (value !== undefined) {
      body.set(key, value);
    }
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  const json = await res.json().catch(() => ({})) as Record<string, any>;
  if (!res.ok) {
    if (json.error === 'invalid_grant') {
      throw new InvalidGrantError(json.error_description ?? 'invalid_grant');
    }
    throw new Error(`Token endpoint ${url} answered ${res.status}: ${json.error ?? ''} ${json.error_description ?? ''}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: Number(json.expires_in ?? 3600),
    idToken: json.id_token,
  };
}

/**
 * OneDrive (personal and work/school) through the Microsoft identity platform.
 * Scope is the app folder only. Refresh tokens rotate on every refresh.
 */
export class OneDriveProvider implements Provider {
  public readonly name = 'onedrive';
  private readonly authority: string;

  public constructor(private readonly client: ClientConfig, tenant = 'common') {
    this.authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  }

  private readonly scope = 'openid email offline_access Files.ReadWrite.AppFolder';

  public authorizeUrl({ state, challenge, redirectUri, loginHint }: { state: string; challenge: string; redirectUri: string; loginHint?: string }): string {
    const url = new URL(`${this.authority}/authorize`);
    url.search = new URLSearchParams({
      client_id: this.client.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: this.scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
      ...loginHint ? { login_hint: loginHint } : {},
    }).toString();
    return url.href;
  }

  public exchange(code: string, verifier: string, redirectUri: string): Promise<TokenSet> {
    return tokenRequest(`${this.authority}/token`, {
      grant_type: 'authorization_code',
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      scope: this.scope,
    });
  }

  public refresh(refreshToken: string): Promise<TokenSet> {
    return tokenRequest(`${this.authority}/token`, {
      grant_type: 'refresh_token',
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      refresh_token: refreshToken,
      scope: this.scope,
    });
  }

  public async identify(tokens: TokenSet): Promise<ProviderAccount> {
    const claims = decodeJwtClaims(tokens.idToken);
    return { id: `${claims.tid ?? ''}/${claims.oid ?? claims.sub}`, email: claims.email ?? claims.preferred_username };
  }

  public async revoke(): Promise<'unsupported'> {
    // No per-grant revocation endpoint for personal accounts. The owner removes the app at
    // https://account.live.com/consent/Manage (personal) or https://myapps.microsoft.com (work/school).
    return 'unsupported';
  }
}

/** Dropbox, app-folder permission, offline (non-expiring, non-rotating) refresh token. */
export class DropboxProvider implements Provider {
  public readonly name = 'dropbox';

  public constructor(private readonly client: ClientConfig) {}

  public authorizeUrl({ state, challenge, redirectUri }: { state: string; challenge: string; redirectUri: string }): string {
    const url = new URL('https://www.dropbox.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: this.client.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      token_access_type: 'offline',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'account_info.read files.metadata.read files.metadata.write files.content.read files.content.write',
    }).toString();
    return url.href;
  }

  public exchange(code: string, verifier: string, redirectUri: string): Promise<TokenSet> {
    return tokenRequest('https://api.dropboxapi.com/oauth2/token', {
      grant_type: 'authorization_code',
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
  }

  public refresh(refreshToken: string): Promise<TokenSet> {
    return tokenRequest('https://api.dropboxapi.com/oauth2/token', {
      grant_type: 'refresh_token',
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      refresh_token: refreshToken,
    });
  }

  public async identify(tokens: TokenSet): Promise<ProviderAccount> {
    const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Dropbox get_current_account answered ${res.status}`);
    }
    const body = await res.json() as { account_id: string; email?: string };
    return { id: body.account_id, email: body.email };
  }

  public async revoke(_refreshToken: string, accessToken?: string): Promise<'revoked'> {
    // Revoking an access token also kills the refresh token it came from.
    const token = accessToken ?? (await this.refresh(_refreshToken)).accessToken;
    const res = await fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 401) {
      throw new Error(`Dropbox token/revoke answered ${res.status}`);
    }
    return 'revoked';
  }
}

/** Google Drive with drive.file: the app sees only files it created. */
export class GoogleDriveProvider implements Provider {
  public readonly name = 'googledrive';

  public constructor(private readonly client: ClientConfig) {}

  public authorizeUrl({ state, challenge, redirectUri, loginHint }: { state: string; challenge: string; redirectUri: string; loginHint?: string }): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.client.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid email https://www.googleapis.com/auth/drive.file',
      access_type: 'offline',
      // Without consent, a re-link gets no refresh token.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...loginHint ? { login_hint: loginHint } : {},
    }).toString();
    return url.href;
  }

  public exchange(code: string, verifier: string, redirectUri: string): Promise<TokenSet> {
    return tokenRequest('https://oauth2.googleapis.com/token', {
      grant_type: 'authorization_code',
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
  }

  public refresh(refreshToken: string): Promise<TokenSet> {
    return tokenRequest('https://oauth2.googleapis.com/token', {
      grant_type: 'refresh_token',
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      refresh_token: refreshToken,
    });
  }

  public async identify(tokens: TokenSet): Promise<ProviderAccount> {
    const claims = decodeJwtClaims(tokens.idToken);
    return { id: claims.sub, email: claims.email };
  }

  public async revoke(refreshToken: string): Promise<'revoked'> {
    const res = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    });
    // 400 invalid_token means it is already dead.
    if (!res.ok && res.status !== 400) {
      throw new Error(`Google revoke answered ${res.status}`);
    }
    return 'revoked';
  }
}

/**
 * A provider that needs no network, for tests. It behaves like Microsoft: every refresh rotates the
 * refresh token. Its access tokens are `fake-at.<account>.<random>`, which the plugin's LocalFolderAdapter accepts.
 * Never enable in production.
 */
export class FakeProvider implements Provider {
  public readonly name = 'fake';
  private readonly valid = new Set<string>();
  public refreshCount = 0;
  /** When true, a refresh invalidates the refresh token it used (stricter than Microsoft). */
  public strictRotation = false;

  public authorizeUrl({ state, redirectUri, loginHint }: { state: string; redirectUri: string; loginHint?: string }): string {
    const url = new URL(redirectUri);
    url.searchParams.set('code', `fake-code.${loginHint ?? 'alice'}`);
    url.searchParams.set('state', state);
    return url.href;
  }

  private issue(account: string): TokenSet {
    const refreshToken = `fake-rt.${account}.${randomBytes(8).toString('hex')}`;
    this.valid.add(refreshToken);
    return { accessToken: `fake-at.${account}.${randomBytes(8).toString('hex')}`, refreshToken, expiresIn: 3600, idToken: account };
  }

  public async exchange(code: string): Promise<TokenSet> {
    if (!code.startsWith('fake-code.')) {
      throw new InvalidGrantError('bad code');
    }
    return this.issue(code.slice('fake-code.'.length));
  }

  public async refresh(refreshToken: string): Promise<TokenSet> {
    this.refreshCount += 1;
    if (!this.valid.has(refreshToken)) {
      throw new InvalidGrantError('unknown refresh token');
    }
    if (this.strictRotation) {
      this.valid.delete(refreshToken);
    }
    return this.issue(refreshToken.split('.')[1]);
  }

  public async identify(tokens: TokenSet): Promise<ProviderAccount> {
    return { id: tokens.idToken!, email: `${tokens.idToken}@example.test` };
  }

  public async revoke(refreshToken: string): Promise<'revoked'> {
    this.valid.delete(refreshToken);
    return 'revoked';
  }

  /** Test hook: kill all grants, as if the user revoked the app at the provider. */
  public revokeAll(): void {
    this.valid.clear();
  }
}

export function providersFromEnv(env: Record<string, string | undefined>): Map<ProviderName, Provider> {
  const providers = new Map<ProviderName, Provider>();
  if (env.ONEDRIVE_CLIENT_ID) {
    providers.set('onedrive', new OneDriveProvider(
      { clientId: env.ONEDRIVE_CLIENT_ID, clientSecret: env.ONEDRIVE_CLIENT_SECRET },
      env.ONEDRIVE_TENANT ?? 'common',
    ));
  }
  if (env.DROPBOX_CLIENT_ID) {
    providers.set('dropbox', new DropboxProvider({ clientId: env.DROPBOX_CLIENT_ID, clientSecret: env.DROPBOX_CLIENT_SECRET }));
  }
  if (env.GOOGLE_CLIENT_ID) {
    providers.set('googledrive', new GoogleDriveProvider({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }));
  }
  if (env.BROKER_FAKE_PROVIDER === '1') {
    providers.set('fake', new FakeProvider());
  }
  return providers;
}
