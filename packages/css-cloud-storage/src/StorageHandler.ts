import type { JsonInteractionHandlerInput, JsonRepresentation, JsonView } from '@solid/community-server';
import { assertAccountId, BadRequestHttpError, JsonInteractionHandler } from '@solid/community-server';
import type { TokenBrokerClient } from './TokenBrokerClient';

/**
 * The account's connected storage, at /.account/account/<id>/storage/.
 *
 * - GET: `{ providers, sessionProviders, links }`
 * - POST `{ provider }`: starts linking; returns `{ authorizeUrl }` to send the browser to.
 * - POST `{ code, state }`: finishes linking (posted by the callback page); returns `{ link }`.
 * - POST `{ unlink: "<linkId>" }`: revokes at the provider and shreds the stored grant.
 * - POST `{ sessionConfig: "<provider>" }`: private mode; what the browser needs to sign in to the provider itself.
 * - POST `{ session: { provider, accessToken, expiresIn } }`: private mode; an access token from the owner's
 *   browser. Creates the private-mode link on first use and keeps it online.
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
    const [ info, links ] = await Promise.all([ this.broker.providerInfo(), this.broker.links(accountId) ]);
    return { json: { providers: info.providers, sessionProviders: info.session, links: links as any }};
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
    if (typeof body.sessionConfig === 'string') {
      return { json: await this.broker.sessionConfig(body.sessionConfig) as any };
    }
    const session = body.session as Record<string, unknown> | undefined;
    if (session && typeof session.provider === 'string' && typeof session.accessToken === 'string') {
      const link = await this.broker.pushSession(session.provider, accountId, session.accessToken, Number(session.expiresIn));
      return { json: { link: link as any }};
    }
    throw new BadRequestHttpError('Expected { provider }, { code, state }, { unlink }, { sessionConfig } or { session }.');
  }
}
