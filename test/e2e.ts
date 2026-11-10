// End-to-end check of CSS + css-cloud-storage + the token broker, using the broker's fake provider.
// Start deploy/compose.test.yaml first, then: bun test/e2e.ts
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.BASE ?? 'http://localhost:3998/';
const brokerUrl = process.env.BROKER ?? 'http://localhost:3997';
const brokerKey = 'test-service-key-test-service-key-0001';
const cloudDir = join(import.meta.dir, '..', '.test-data', 'fake-cloud');
const run = Date.now().toString(36);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures += 1;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' };
async function post(url: string, body: unknown, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...jsonHeaders, ...token ? { authorization: `CSS-Account-Token ${token}` } : {}},
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch((): undefined => undefined) };
}
async function get(url: string, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: { accept: 'application/json', ...token ? { authorization: `CSS-Account-Token ${token}` } : {}}});
  return { status: res.status, body: await res.json().catch((): undefined => undefined) };
}

async function signUp(code: string, name: string): Promise<{ token: string; controls: any }> {
  const created = await post(`${base}.account/account/`, { inviteCode: code });
  if (created.status !== 200) {
    throw new Error(`sign-up ${name}: ${created.status} ${created.body?.message}`);
  }
  const token = created.body.authorization as string;
  const { body: { controls }} = await get(`${base}.account/`, token);
  await post(controls.password.create, { email: `${name}-${run}@example.invalid`, password: `${name}-password-1` }, token);
  return { token, controls };
}

/** Client-credentials Bearer token for a WebID, to make authenticated LDP requests. */
async function solidToken(controls: any, token: string, webId: string): Promise<string> {
  const cred = await post(controls.account.clientCredentials, { name: `e2e-${run}`, webId }, token);
  const res = await fetch(`${base}.oidc/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(cred.body.id)}:${encodeURIComponent(cred.body.secret)}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=webid',
  });
  const body = await res.json() as { access_token?: string; error?: string };
  if (!body.access_token) {
    throw new Error(`token endpoint: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

// ------------------------------------------------------------------ accounts and linking

// Invite codes are single use. Against a stack that keeps its data, pass fresh ones: E2E_CODES=a,b
const [ codeA, codeB ] = (process.env.E2E_CODES ?? 'SEED-TEST-CODE-0001,SEED-TEST-CODE-0002').split(',');
const alice = await signUp(codeA, 'alice');
const bob = await signUp(codeB, 'bob');
check('account controls include storage', typeof alice.controls.account.storage === 'string', alice.controls.account.storage);

const storageUrl: string = alice.controls.account.storage;
const view = await get(storageUrl, alice.token);
check('storage view lists the fake provider and no links', view.status === 200 &&
  view.body.providers.includes('fake') && view.body.links.length === 0, JSON.stringify(view.body));

check('storage API needs a login', (await get(storageUrl)).status === 401);
check('another account cannot read it', (await get(storageUrl, bob.token)).status === 403);

const start = await post(storageUrl, { provider: 'fake' }, alice.token);
const authorizeUrl = new URL(start.body?.authorizeUrl);
check('starting a link returns the provider URL', authorizeUrl.pathname === '/.account/storage/callback/', authorizeUrl.href);

const callbackPage = await fetch(authorizeUrl, { headers: { accept: 'text/html' }});
check('callback page renders', callbackPage.status === 200 && (await callbackPage.text()).includes('Connecting storage'));

// Bob tries to finish Alice's link request (e.g. she sent him the URL, or he sent her his).
const stolen = await post(bob.controls.account.storage, {
  code: authorizeUrl.searchParams.get('code'), state: authorizeUrl.searchParams.get('state'),
}, bob.token);
check('a link request cannot be finished by another account', stolen.status === 403, stolen.body?.message);

const restart = new URL((await post(storageUrl, { provider: 'fake' }, alice.token)).body.authorizeUrl);
const done = await post(storageUrl, {
  code: restart.searchParams.get('code'), state: restart.searchParams.get('state'),
}, alice.token);
check('alice links the fake provider', done.status === 200 && done.body.link?.status === 'active', JSON.stringify(done.body));
const linkId: string = done.body.link.linkId;

const replay = await post(storageUrl, {
  code: restart.searchParams.get('code'), state: restart.searchParams.get('state'),
}, alice.token);
check('a callback cannot be replayed', replay.status === 400, replay.body?.message);

// ------------------------------------------------------------------ pods

const cloudPod = `ac${run}`;
const localPod = `al${run}`;
rmSync(join(cloudDir, 'alice', cloudPod), { recursive: true, force: true });

const bobsTry = await post(bob.controls.account.pod, { name: `bob${run}`, settings: { linkId }}, bob.token);
check('bob cannot put a pod in alice\'s storage', bobsTry.status === 404, `${bobsTry.status} ${bobsTry.body?.message}`);

const made = await post(alice.controls.account.pod, { name: cloudPod, settings: { linkId }}, alice.token);
check('alice creates a pod in her linked storage', made.status === 200, `${made.status} ${made.body?.message}`);
const podUrl: string = made.body.pod;
const webId: string = made.body.webId;
check('starter files land in the cloud folder in the CSS file layout',
  existsSync(join(cloudDir, 'alice', cloudPod, 'profile', 'card$.ttl')) &&
  existsSync(join(cloudDir, 'alice', cloudPod, '.acl')), join(cloudDir, 'alice', cloudPod));

const local = await post(alice.controls.account.pod, { name: localPod }, alice.token);
check('a pod without linkId stays on the server', local.status === 200 &&
  !existsSync(join(cloudDir, 'alice', localPod)), String(local.status));

const card = await fetch(`${podUrl}profile/card`, { headers: { accept: 'text/turtle' }});
const cardText = await card.text();
check('the WebID profile is served from the cloud', card.status === 200 && cardText.includes('foaf:PrimaryTopic') ||
  cardText.includes('PersonalProfileDocument'), String(card.status));

const anonymous = await fetch(`${podUrl}anon.txt`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'x' });
check('anonymous writes are refused', anonymous.status === 401, String(anonymous.status));

// ------------------------------------------------------------------ LDP through the cloud

const bearer = await solidToken(alice.controls, alice.token, webId);
const auth = { authorization: `Bearer ${bearer}` };

const put = await fetch(`${podUrl}notes/hello.txt`, { method: 'PUT', headers: { ...auth, 'content-type': 'text/plain' }, body: 'hello cloud' });
check('PUT a document (creating its container)', put.status === 201, String(put.status));
check('…stored as notes/hello.txt', readFileSync(join(cloudDir, 'alice', cloudPod, 'notes', 'hello.txt'), 'utf8') === 'hello cloud');

const read = await fetch(`${podUrl}notes/hello.txt`, { headers: auth });
check('GET it back', read.status === 200 && await read.text() === 'hello cloud' &&
  read.headers.get('content-type')?.startsWith('text/plain') === true, read.headers.get('content-type') ?? '');

const turtle = await fetch(`${podUrl}notes/thing`, {
  method: 'PUT', headers: { ...auth, 'content-type': 'text/turtle' }, body: '<#it> <http://schema.org/name> "thing".',
});
check('PUT turtle at a name without an extension', turtle.status === 201, String(turtle.status));
check('…stored with a $.ttl suffix, like the file backend', existsSync(join(cloudDir, 'alice', cloudPod, 'notes', 'thing$.ttl')));
const thing = await fetch(`${podUrl}notes/thing`, { headers: { ...auth, accept: 'text/turtle' }});
check('…and served back as turtle', thing.status === 200 && thing.headers.get('content-type')?.startsWith('text/turtle') === true);

const patch = await fetch(`${podUrl}notes/thing`, {
  method: 'PATCH',
  headers: { ...auth, 'content-type': 'text/n3' },
  body: `@prefix solid: <http://www.w3.org/ns/solid/terms#>. _:p a solid:InsertDeletePatch;
    solid:inserts { <#it> <http://schema.org/description> "patched". }.`,
});
const patched = await (await fetch(`${podUrl}notes/thing`, { headers: { ...auth, accept: 'text/turtle' }})).text();
check('PATCH (read-modify-write) works', patch.status === 205 && patched.includes('patched'), `${patch.status}`);

const listing = await (await fetch(`${podUrl}notes/`, { headers: { ...auth, accept: 'text/turtle' }})).text();
check('container listing shows both documents', listing.includes('hello.txt') && listing.includes('<thing>'), listing.slice(0, 200));

const etag = (await fetch(`${podUrl}notes/hello.txt`, { method: 'HEAD', headers: auth })).headers.get('etag');
const stale = await fetch(`${podUrl}notes/hello.txt`, {
  method: 'PUT', headers: { ...auth, 'content-type': 'text/plain', 'if-match': '"nope"' }, body: 'x',
});
check('If-Match with a stale ETag is refused', stale.status === 412, String(stale.status));
const fresh = await fetch(`${podUrl}notes/hello.txt`, {
  method: 'PUT', headers: { ...auth, 'content-type': 'text/plain', 'if-match': etag ?? '' }, body: 'hello again',
});
check('If-Match with the current ETag is accepted', fresh.status === 205, `${fresh.status} ${etag}`);

const del = await fetch(`${podUrl}notes/hello.txt`, { method: 'DELETE', headers: auth });
check('DELETE removes the file from the cloud folder', del.status === 205 &&
  !existsSync(join(cloudDir, 'alice', cloudPod, 'notes', 'hello.txt')), String(del.status));

const binary = Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 256));
const bin = await fetch(`${podUrl}blob.bin`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: binary });
const back = Buffer.from(await (await fetch(`${podUrl}blob.bin`, { headers: auth })).arrayBuffer());
check('binary round trip', bin.status === 201 && back.equals(binary), `${bin.status} ${back.length}`);

// ------------------------------------------------------------------ HTML pages

const html = { accept: 'text/html', authorization: `CSS-Account-Token ${alice.token}` };
const pages = await Promise.all([ storageUrl, alice.controls.html.account.account, alice.controls.html.account.createPod ]
  .map(async(url) => (await fetch(url, { headers: html })).text()));
check('storage page renders', pages[0].includes('Connected storage'));
check('account page has the storage section', pages[1].includes('id="storage"'));
check('create-pod page asks where to store the pod', pages[2].includes('id="linkId"'));

// ------------------------------------------------------------------ broker secrets and unlinking

const proc = Bun.spawnSync([ 'docker', 'exec', 'ubisolid-test-broker-1', 'bun', '-e',
  "const {Database}=require('bun:sqlite');console.log(JSON.stringify(new Database('/data/broker.sqlite').query('select * from links').all()))" ]);
const dump = proc.stdout.toString();
check('the broker database holds no refresh token in the clear', dump.includes(linkId) && !dump.includes('fake-rt.'), dump.slice(0, 120));

const tokenDirect = await fetch(`${brokerUrl}/links/${linkId}/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ podBase: podUrl }),
});
check('the broker refuses callers without the service key', tokenDirect.status === 401);
const wrongPod = await fetch(`${brokerUrl}/links/${linkId}/token`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${brokerKey}` },
  body: JSON.stringify({ podBase: `${base}${localPod}/` }),
});
check('the broker only issues tokens for pods bound to the link', wrongPod.status === 403);

const unlink = await post(storageUrl, { unlink: linkId }, alice.token);
check('alice disconnects her storage', unlink.status === 200 && unlink.body.revokedAtProvider === 'revoked', JSON.stringify(unlink.body));
const offline = await fetch(`${podUrl}profile/card`);
check('the cloud pod goes offline with 503, not an empty local pod', offline.status === 503, String(offline.status));
check('its files stay in the owner\'s storage', existsSync(join(cloudDir, 'alice', cloudPod, 'profile', 'card$.ttl')));
const stillLocal = await fetch(`${base}${localPod}/profile/card`);
check('the local pod is unaffected', stillLocal.status === 200, String(stillLocal.status));

// ---- private mode: bob's browser holds the grant; the server only gets access tokens.
const bobStorage = bob.controls.account.storage;
const bobView = await get(bobStorage, bob.token);
check('private mode is offered for the test provider', bobView.body.sessionProviders?.includes('fake'), JSON.stringify(bobView.body.sessionProviders));
const config = await post(bobStorage, { sessionConfig: 'fake' }, bob.token);
check('the browser gets the provider\'s endpoints and the session redirect URI',
  config.status === 200 && config.body.redirectUri === `${base}.account/storage/session/`, JSON.stringify(config.body));
// What the session page does: PKCE code exchange straight with the provider, then hand over the access token.
const noPkce = await fetch(config.body.tokenEndpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: 'fake-code.bob' }) });
check('the provider refuses a code exchange without PKCE', noPkce.status === 400);
const browserTokens = await (await fetch(config.body.tokenEndpoint, {
  method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: 'fake-code.bob', code_verifier: 'v'.repeat(43) }),
})).json() as Record<string, any>;
const pushed = await post(bobStorage, { session: { provider: 'fake', accessToken: browserTokens.access_token, expiresIn: browserTokens.expires_in } }, bob.token);
check('pushing an access token creates a private-mode link', pushed.status === 200 && pushed.body.link.mode === 'session' && Boolean(pushed.body.link.onlineUntil), JSON.stringify(pushed.body));
const forged = await post(bobStorage, { session: { provider: 'fake', accessToken: 'made-up', expiresIn: 3600 } }, bob.token);
check('a token the provider doesn\'t recognise is refused', forged.status === 400, String(forged.status));
const privatePod = `pm${run}`;
const pmPod = await post(bob.controls.account.pod, { name: privatePod, settings: { linkId: pushed.body.link.linkId } }, bob.token);
check('bob creates a pod in private mode', pmPod.status === 200, JSON.stringify(pmPod.body));
const pmRead = await fetch(`${base}${privatePod}/profile/card`);
check('it is served while bob is connected', pmRead.status === 200, String(pmRead.status));
check('its files are in bob\'s storage', existsSync(join(cloudDir, 'bob', privatePod, 'profile', 'card$.ttl')));
const pmDump = Bun.spawnSync([ 'docker', 'exec', 'ubisolid-test-broker-1', 'bun', '-e',
  "const {Database}=require('bun:sqlite');console.log(JSON.stringify(new Database('/data/broker.sqlite').query('select * from links').all()))" ]).stdout.toString();
check('the broker stores no token at all for a private-mode link', pmDump.includes(pushed.body.link.linkId) &&
  !pmDump.includes(browserTokens.refresh_token) && !pmDump.includes(browserTokens.access_token));
// Bob's browser goes away; a token that ran out takes the pod offline. Push one with 61 s left, wait past the margin.
await post(bobStorage, { session: { provider: 'fake', accessToken: browserTokens.access_token, expiresIn: 62 } }, bob.token);
await Bun.sleep(3_000);
const pmOffline = await fetch(`${base}${privatePod}/profile/card`);
check('when bob\'s browser stops renewing, the pod answers 503', pmOffline.status === 503, String(pmOffline.status));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
