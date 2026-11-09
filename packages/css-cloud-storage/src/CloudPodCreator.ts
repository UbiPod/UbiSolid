import type {
  IdentifierGenerator,
  PodCreatorInput,
  PodCreatorOutput,
  PodStore,
} from '@solid/community-server';
import { BadRequestHttpError, ConflictHttpError, getLoggerFor, PodCreator } from '@solid/community-server';
import type { PodLinkIndex } from './PodLinkIndex';
import type { TokenBrokerClient } from './TokenBrokerClient';

/**
 * Wraps CSS's pod creator. When the request's `settings.linkId` names one of the account's storage links,
 * the pod is bound to that link before the starter resources are written, so they land in the cloud
 * from the first write. Without `settings.linkId` it behaves exactly like the stock creator.
 */
export class CloudPodCreator extends PodCreator {
  protected readonly logger = getLoggerFor(this);

  /**
   * @param source - The stock BasePodCreator.
   * @param identifierGenerator - Same generator the source uses, to know the pod's base URL in advance.
   * @param podStore - To refuse names that already exist.
   * @param broker - Token broker client.
   * @param pods - The pod index to update.
   */
  public constructor(
    private readonly source: PodCreator,
    private readonly identifierGenerator: IdentifierGenerator,
    private readonly podStore: PodStore,
    private readonly broker: TokenBrokerClient,
    private readonly pods: PodLinkIndex,
  ) {
    super();
  }

  public async canHandle(input: PodCreatorInput): Promise<void> {
    await this.source.canHandle(input);
  }

  public async handle(input: PodCreatorInput): Promise<PodCreatorOutput> {
    const linkId = input.settings?.linkId;
    if (linkId === undefined || linkId === '') {
      return this.source.handle(input);
    }
    if (typeof linkId !== 'string') {
      throw new BadRequestHttpError('settings.linkId must be a string.');
    }
    if (!input.name) {
      throw new BadRequestHttpError('A pod in linked storage needs a name.');
    }
    const base = this.identifierGenerator.generate(input.name);
    if (await this.podStore.findByBaseUrl(base.path)) {
      throw new ConflictHttpError(`There already is a pod at ${base.path}.`);
    }
    // The broker checks the link belongs to this account and is active.
    await this.broker.bindPod(base.path, linkId, input.accountId);
    this.pods.add({ podBase: base.path, linkId });
    try {
      const output = await this.source.handle(input);
      this.logger.info(`Created pod ${output.podUrl} in linked storage ${linkId}`);
      return output;
    } catch (error) {
      this.pods.remove(base.path);
      await this.broker.unbindPod(base.path, input.accountId).catch((unbindError: Error) =>
        this.logger.error(`Could not unbind ${base.path} after a failed creation: ${unbindError.message}`));
      throw error;
    }
  }
}
