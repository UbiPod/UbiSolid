import type { JsonInteractionHandlerInput, JsonRepresentation, JsonView } from '@solid/community-server';
import { assertAccountId, BadRequestHttpError, JsonInteractionHandler } from '@solid/community-server';
import type { TokenBrokerClient } from './TokenBrokerClient';

/**
 * The account's connected storage, at /.account/account/<id>/storage/.
 *
 * - GET: `{ providers, links }`
 * - POST `{ provider }`: starts linking; returns `{ authorizeUrl }` to send the browser to.
 * - POST `{ code, state }`: finishes linking (posted by the callback page); returns `{ link }`.
 * - POST `{ unlink: "<linkId>" }`: revokes at the provider and shreds the stored grant.
 *
 * The broker ties each link request to the account that started it, and this handler only ever passes the
 * logged-in account's ID, so a callback URL sent to someone else can't link storage across accounts.
 */
export class StorageHandler extends JsonInteractionHandler implements JsonView {
  public constructor(private readonly broker: TokenBrokerClient) {
    super();
  }

  public async getView({ accountId }: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    assertAccountId(accountId);
    const [ providers, links ] = await Promise.all([ this.broker.providers(), this.broker.links(accountId) ]);
    return { json: { providers, links: links as any }};
  }

  public async handle({ accountId, json }: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    assertAccountId(accountId);
    const body = (json ?? {}) as Record<string, unknown>;
    if (typeof body.provider === 'string') {
      return { json: { authorizeUrl: await this.broker.startLink(body.provider, accountId) }};
    }
    if (typeof body.code === 'string' && typeof body.state === 'string') {
      return { json: { link: await this.broker.completeLink(body.code, body.state, accountId) as any }};
    }
    if (typeof body.unlink === 'string') {
      return { json: await this.broker.unlink(body.unlink, accountId) };
    }
    throw new BadRequestHttpError('Expected { provider }, { code, state } or { unlink }.');
  }
}
