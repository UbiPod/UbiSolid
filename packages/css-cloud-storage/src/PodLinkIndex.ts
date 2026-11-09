import { getLoggerFor } from '@solid/community-server';
import { StorageUnavailableHttpError } from './CloudFs';
import type { TokenBrokerClient } from './TokenBrokerClient';

export interface PodLink {
  podBase: string;
  linkId: string;
}

/**
 * Which pods live in the cloud: podBase -> linkId, from the broker, refreshed every minute and
 * updated immediately when this process binds a pod.
 *
 * It fails closed: if the broker can't be reached and nothing is cached yet, pod requests get 503
 * instead of quietly falling through to local disk.
 */
export class PodLinkIndex {
  protected readonly logger = getLoggerFor(this);
  private links: PodLink[] | undefined;
  private loadedAt = 0;
  private loading?: Promise<void>;

  /**
   * @param broker - The token broker client.
   * @param baseUrl - The server's base URL; documents directly under it and /.internal/ never live in a pod.
   * @param ttlSeconds - How long to trust the cached index.
   */
  public constructor(
    private readonly broker: TokenBrokerClient,
    private readonly baseUrl: string,
    private readonly ttlSeconds = 60,
  ) {}

  /** True for resources that can never be inside a pod, so they never need the broker. */
  public isServerLocal(path: string): boolean {
    if (!path.startsWith(this.baseUrl)) {
      return true;
    }
    const rest = path.slice(this.baseUrl.length);
    return rest === '' || rest.startsWith('.internal/') || !rest.includes('/');
  }

  private async load(): Promise<void> {
    this.loading ??= this.broker.pods().then((links) => {
      this.links = links;
      this.loadedAt = Date.now();
    }).finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  public async match(path: string): Promise<PodLink | undefined> {
    if (this.isServerLocal(path)) {
      return undefined;
    }
    if (!this.links || Date.now() - this.loadedAt > this.ttlSeconds * 1000) {
      try {
        await this.load();
      } catch (error) {
        if (!this.links) {
          throw new StorageUnavailableHttpError('Cannot tell where this pod is stored: the token broker is unreachable.',
            { cause: error });
        }
        this.logger.warn(`Using a stale pod index: ${(error as Error).message}`);
      }
    }
    let best: PodLink | undefined;
    for (const link of this.links!) {
      if (path.startsWith(link.podBase) && (!best || link.podBase.length > best.podBase.length)) {
        best = link;
      }
    }
    return best;
  }

  public add(link: PodLink): void {
    this.links = [ ...(this.links ?? []).filter((l) => l.podBase !== link.podBase), link ];
  }

  public remove(podBase: string): void {
    this.links = this.links?.filter((l) => l.podBase !== podBase);
  }
}
