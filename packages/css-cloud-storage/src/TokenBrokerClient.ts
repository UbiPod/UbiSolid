import {
  BadRequestHttpError,
  ConflictHttpError,
  ForbiddenHttpError,
  getLoggerFor,
  NotFoundHttpError,
} from '@solid/community-server';
import { StorageUnavailableHttpError } from './CloudFs';

export interface IssuedToken {
  accessToken: string;
  expiresAt: number;
  provider: string;
  root: string;
}

export interface StorageLink {
  linkId: string;
  provider: string;
  email?: string;
  status: string;
  createdAt: string;
  lastRefreshedAt?: string;
  pods: string[];
}

const EARLY_MS = 5 * 60_000;

/**
 * Talks to the token broker. Keeps issued access tokens in memory until 5 minutes before they expire,
 * with one request in flight per link. Never sees a refresh token.
 *
 * The URL and service key come from the constructor, or from the BROKER_URL and BROKER_SERVICE_KEY
 * environment variables (not CSS_*, which CSS would treat as command-line options).
 */
export class TokenBrokerClient {
  protected readonly logger = getLoggerFor(this);
  private readonly url: string;
  private readonly key: string;
  private readonly cache = new Map<string, IssuedToken>();
  private readonly inflight = new Map<string, Promise<IssuedToken>>();

  /**
   * @param url - Broker base URL, e.g. http://ubisolid-broker:8600. Defaults to BROKER_URL.
   * @param serviceKey - Shared secret. Defaults to BROKER_SERVICE_KEY.
   */
  public constructor(url?: string, serviceKey?: string) {
    this.url = (url ?? process.env.BROKER_URL ?? '').replace(/\/+$/u, '');
    this.key = serviceKey ?? process.env.BROKER_SERVICE_KEY ?? '';
    if (!this.url || !this.key) {
      throw new Error('css-cloud-storage needs BROKER_URL and BROKER_SERVICE_KEY.');
    }
  }

  public async call<T>(method: string, path: string, body?: object): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`,
          ...body ? { 'content-type': 'application/json' } : {},
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new StorageUnavailableHttpError('The token broker is unreachable.', { cause: error });
    }
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok) {
      return json as T;
    }
    const message = typeof json.error === 'string' ? json.error : `broker answered ${res.status}`;
    switch (res.status) {
      case 400: throw new BadRequestHttpError(message);
      case 403: throw new ForbiddenHttpError(message);
      case 404: throw new NotFoundHttpError(message);
      case 409: throw new ConflictHttpError(message);
      default: throw new StorageUnavailableHttpError(message);
    }
  }

  public async token(linkId: string, podBase: string): Promise<IssuedToken> {
    const key = `${linkId} ${podBase}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - EARLY_MS > Date.now()) {
      return cached;
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.call<IssuedToken>('POST', `/links/${encodeURIComponent(linkId)}/token`, { podBase })
        .then((token) => {
          this.cache.set(key, token);
          return token;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /** Forget a cached token, e.g. after the provider rejected it. */
  public invalidate(linkId: string, podBase: string): void {
    this.cache.delete(`${linkId} ${podBase}`);
  }

  public async providers(): Promise<string[]> {
    return (await this.call<{ providers: string[] }>('GET', '/providers')).providers;
  }

  public async links(accountId: string): Promise<StorageLink[]> {
    return (await this.call<{ links: StorageLink[] }>('GET', `/links?accountId=${encodeURIComponent(accountId)}`)).links;
  }

  public async startLink(provider: string, accountId: string): Promise<string> {
    return (await this.call<{ authorizeUrl: string }>('POST', '/links', { provider, accountId })).authorizeUrl;
  }

  public async completeLink(code: string, state: string, accountId: string): Promise<StorageLink> {
    return (await this.call<{ link: StorageLink }>('POST', '/callback', { code, state, accountId })).link;
  }

  public async unlink(linkId: string, accountId: string): Promise<{ provider: string; revokedAtProvider: string }> {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${linkId} `)) {
        this.cache.delete(key);
      }
    }
    return this.call('DELETE', `/links/${encodeURIComponent(linkId)}?accountId=${encodeURIComponent(accountId)}`);
  }

  public async pods(): Promise<{ podBase: string; linkId: string }[]> {
    return (await this.call<{ pods: { podBase: string; linkId: string }[] }>('GET', '/pods')).pods;
  }

  public async bindPod(podBase: string, linkId: string, accountId: string): Promise<void> {
    await this.call('PUT', '/pods', { podBase, linkId, accountId });
  }

  public async unbindPod(podBase: string, accountId: string): Promise<void> {
    await this.call('DELETE', '/pods', { podBase, accountId });
  }
}
