import { timingSafeEqual } from 'node:crypto';
import { Broker, BrokerError } from './broker';
import { keyWrapperFromEnv } from './crypto';
import { FakeProvider, providersFromEnv } from './providers';

/**
 * The broker's internal API. Only CSS talks to it, with a shared service key; it has no public routes.
 * The OAuth callback lands on CSS (/.account/storage/callback/), which forwards code, state and the
 * browser session's account ID here.
 */
export function createServer(broker: Broker, serviceKey: string, fake?: FakeProvider, sessionRedirectUri = '',
  provisionerKey?: string) {
  const matches = (req: Request, key: string): boolean => {
    const expected = Buffer.from(`Bearer ${key}`);
    const got = Buffer.from(req.headers.get('authorization') ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const authorized = (req: Request): boolean => matches(req, serviceKey);
  // Tenant provisioning has its own key: CSS can't activate links, and the job can't get tokens.
  const provisioner = (req: Request): boolean => Boolean(provisionerKey) && matches(req, provisionerKey!);

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

  const need = (body: Record<string, unknown>, ...keys: string[]): void => {
    for (const key of keys) {
      if (typeof body[key] !== 'string' || !body[key]) {
        throw new BrokerError(400, `Missing ${key}.`);
      }
    }
  };

  return async(req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') {
      return json({ ok: true });
    }
    if (fake && url.pathname.startsWith('/fake/')) {
      return fakeBrowserRoutes(fake, req, url);
    }
    if (url.pathname.startsWith('/tenant/')) {
      if (!provisioner(req)) {
        return json({ error: 'unauthorized' }, 401);
      }
      return tenantRoutes(broker, req, url, json);
    }
    if (!authorized(req)) {
      return json({ error: 'unauthorized' }, 401);
    }
    try {
      const body = req.method === 'GET' || req.method === 'DELETE' && !req.headers.get('content-length') ?
        {} :
        await req.json() as Record<string, any>;
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/providers') {
        return json({ providers: broker.providerNames(), session: broker.sessionProviderNames() });
      }
      if (req.method === 'GET' && url.pathname === '/links') {
        const accountId = url.searchParams.get('accountId');
        if (!accountId) {
          throw new BrokerError(400, 'Missing accountId.');
        }
        return json({ links: broker.links(accountId) });
      }
      if (req.method === 'POST' && url.pathname === '/links') {
        need(body, 'provider', 'accountId');
        return json(broker.createLink(body.provider, body.accountId, body.loginHint), 201);
      }
      if (req.method === 'POST' && url.pathname === '/callback') {
        need(body, 'code', 'state', 'accountId');
        return json({ link: await broker.completeLink(body.code, body.state, body.accountId) });
      }
      if (req.method === 'POST' && parts[0] === 'links' && parts[2] === 'token' && parts.length === 3) {
        need(body, 'podBase');
        return json(await broker.token(parts[1], body.podBase));
      }
      if (req.method === 'DELETE' && parts[0] === 'links' && parts.length === 2) {
        const accountId = url.searchParams.get('accountId');
        if (!accountId) {
          throw new BrokerError(400, 'Missing accountId.');
        }
        return json(await broker.unlink(parts[1], accountId));
      }
      if (req.method === 'POST' && url.pathname === '/session/config') {
        need(body, 'provider');
        return json(broker.sessionConfig(body.provider, sessionRedirectUri));
      }
      if (req.method === 'POST' && url.pathname === '/session/push') {
        need(body, 'provider', 'accountId', 'accessToken');
        return json({ link: await broker.pushSessionToken(body.accountId, body.provider, body.accessToken, body.expiresIn) });
      }
      if (req.method === 'GET' && url.pathname === '/pods') {
        return json({ pods: broker.pods() });
      }
      if (req.method === 'PUT' && url.pathname === '/pods') {
        need(body, 'podBase', 'linkId', 'accountId');
        return json(broker.bindPod(body.podBase, body.linkId, body.accountId));
      }
      if (req.method === 'DELETE' && url.pathname === '/pods') {
        need(body, 'podBase', 'accountId');
        broker.unbindPod(body.podBase, body.accountId);
        return json({ ok: true });
      }
      if (fake && req.method === 'POST' && url.pathname === '/test/revoke-all') {
        fake.revokeAll();
        return json({ ok: true, refreshCount: fake.refreshCount });
      }
      if (fake && req.method === 'GET' && url.pathname === '/test/stats') {
        return json({ refreshCount: fake.refreshCount });
      }
      if (fake && req.method === 'POST' && url.pathname === '/test/session-expires-in') {
        // Lifetime of access tokens the fake browser endpoint hands out, to test going offline.
        fake.sessionExpiresIn = Number(body.seconds ?? 3600);
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    } catch (error) {
      if (error instanceof BrokerError) {
        const headers: Record<string, string> = error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {};
        return json({ error: error.message }, error.status, headers);
      }
      if (error instanceof SyntaxError) {
        return json({ error: 'Body must be JSON.' }, 400);
      }
      console.error(error);
      return json({ error: 'internal error' }, 500);
    }
  };
}

async function tenantRoutes(broker: Broker, req: Request, url: URL,
  json: (body: unknown, status?: number) => Response): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/tenant/queue') {
      return json(broker.tenantQueue());
    }
    if (req.method === 'POST' && parts[1] === 'links' && parts[3] === 'activate' && parts.length === 4) {
      const body = await req.json() as Record<string, string>;
      if (!body.driveId || !body.folderId) {
        throw new BrokerError(400, 'Missing driveId or folderId.');
      }
      return json({ link: await broker.tenantActivate(parts[2], { driveId: body.driveId, folderId: body.folderId, permissionId: body.permissionId }) });
    }
    if (req.method === 'POST' && parts[1] === 'links' && parts[3] === 'revoked' && parts.length === 4) {
      broker.tenantRevoked(parts[2]);
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  } catch (error) {
    if (error instanceof BrokerError) {
      return json({ error: error.message }, error.status);
    }
    console.error(error);
    return json({ error: 'internal error' }, 500);
  }
}

/**
 * The fake provider's browser-facing endpoints, for testing private mode. They exist only when
 * BROKER_FAKE_PROVIDER=1, and are the only routes that skip the service key.
 */
async function fakeBrowserRoutes(fake: FakeProvider, req: Request, url: URL): Promise<Response> {
  const cors = {
    'access-control-allow-origin': req.headers.get('origin') ?? '*',
    'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'content-type',
  };
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method === 'GET' && url.pathname === '/fake/authorize') {
    const target = new URL(url.searchParams.get('redirect_uri') ?? '');
    if (url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('code_challenge')) {
      target.searchParams.set('error', 'invalid_request');
    } else {
      target.searchParams.set('code', `fake-code.${url.searchParams.get('login_hint') || 'alice'}`);
    }
    target.searchParams.set('state', url.searchParams.get('state') ?? '');
    return Response.redirect(target.href, 302);
  }
  if (req.method === 'POST' && url.pathname === '/fake/token') {
    try {
      const tokens = await fake.publicToken(new URLSearchParams(await req.text()));
      return Response.json({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: Number(url.searchParams.get('expires_in') ?? fake.sessionExpiresIn),
        token_type: 'Bearer',
      }, { headers: cors });
    } catch {
      return Response.json({ error: 'invalid_grant' }, { status: 400, headers: cors });
    }
  }
  return new Response('not found', { status: 404, headers: cors });
}

if (import.meta.main) {
  const env = process.env;
  const serviceKey = env.BROKER_SERVICE_KEY;
  if (!serviceKey || serviceKey.length < 32) {
    throw new Error('BROKER_SERVICE_KEY must be set to at least 32 characters.');
  }
  if (!env.BROKER_REDIRECT_URI) {
    throw new Error('BROKER_REDIRECT_URI must be set, e.g. https://pod.example/.account/storage/callback/');
  }
  const providers = providersFromEnv(env);
  if (providers.size === 0) {
    throw new Error('No providers configured. Set ONEDRIVE_CLIENT_ID, DROPBOX_CLIENT_ID and/or GOOGLE_CLIENT_ID.');
  }
  const keys = keyWrapperFromEnv(env);
  const broker = new Broker(env.BROKER_DB ?? '/data/broker.sqlite', keys, providers, env.BROKER_REDIRECT_URI);
  const fake = providers.get('fake') as FakeProvider | undefined;
  // Private mode's sign-in page sits next to the normal callback: /.account/storage/session/
  const sessionRedirectUri = env.BROKER_SESSION_REDIRECT_URI ?? env.BROKER_REDIRECT_URI.replace(/callback\/?$/u, 'session/');
  if (env.BROKER_PROVISIONER_KEY && env.BROKER_PROVISIONER_KEY.length < 32) {
    throw new Error('BROKER_PROVISIONER_KEY must be at least 32 characters.');
  }
  const handler = createServer(broker, serviceKey, fake, sessionRedirectUri, env.BROKER_PROVISIONER_KEY);
  const server = env.BROKER_SOCKET ?
    Bun.serve({ unix: env.BROKER_SOCKET, fetch: handler }) :
    Bun.serve({ hostname: env.BROKER_HOST ?? '0.0.0.0', port: Number(env.BROKER_PORT ?? 8600), fetch: handler });
  // Daily keep-warm for Google grants.
  setInterval(() => void broker.keepWarm(), 24 * 3600_000);
  console.log(`token broker listening on ${env.BROKER_SOCKET ?? `${server.hostname}:${server.port}`};`,
    `providers: ${[ ...providers.keys() ].join(', ')}; keys: ${keys.name}`);
  if (fake) {
    console.warn('WARNING: the fake provider is enabled. Never do this in production.');
  }
}
