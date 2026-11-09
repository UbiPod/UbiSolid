import type { AccessMap, Operation } from '@solid/community-server';
import { ModesExtractor } from '@solid/community-server';
import type { PodLinkIndex } from './PodLinkIndex';
import type { TokenBrokerClient } from './TokenBrokerClient';

/**
 * Runs before authorization and answers 503 for a pod whose storage is disconnected or unreachable.
 *
 * Without it such requests still fail closed, but as 401/403: CSS's permission readers swallow storage errors
 * while looking for ACL documents, so "your storage is offline" would look like "you have no access".
 * The check costs nothing while the pod's access token is cached.
 */
export class StorageStatusModesExtractor extends ModesExtractor {
  /**
   * @param source - The stock modes extractor.
   * @param pods - Which pods are linked.
   * @param broker - Token broker client.
   */
  public constructor(
    private readonly source: ModesExtractor,
    private readonly pods: PodLinkIndex,
    private readonly broker: TokenBrokerClient,
  ) {
    super();
  }

  public async canHandle(operation: Operation): Promise<void> {
    await this.source.canHandle(operation);
  }

  public async handle(operation: Operation): Promise<AccessMap> {
    const link = await this.pods.match(operation.target.path);
    if (link) {
      await this.broker.token(link.linkId, link.podBase);
    }
    return this.source.handle(operation);
  }
}
