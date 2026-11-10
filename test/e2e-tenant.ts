// Tenant mode end to end, against the mock Graph:
//   docker compose -f deploy/compose.test.yaml -f deploy/compose.test.tenant.yaml up -d
//   E2E_CODES=SEED-TEST-CODE-0001 bun test/e2e-tenant.ts
// The test plays the user's browser and runs the provisioning job itself.
const base = process.env.BASE ?? 'http://localhost:3998/';
const brokerUrl = 'http://localhost:3997';
const mock = 'http://localhost:3996';
const serviceKey = 'test-service-key-test-service-key-0001';
const provisionerKey = 'test-provisioner-key-test-provisioner-0001';
const brokerApp = 'ubisolid-broker-app';
const run = Date.now().toString(36);
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail.slice(0, 300)})` : ''}`);
}

async function call(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...body ? { 'content-type': 'application/json' } : {},
      ...token ? { authorization: token.startsWith('Bearer ') ? token : `CSS-Account-Token ${token}` } : {},
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function signUp(code: string, name: string): Promise<{ token: string; controls: any }> {
  const created = await call('POST', `${base}.account/account/`, { inviteCode: code });
  if (created.status !== 200) {
    throw new Error(`sign-up ${name}: ${created.status} ${created.body?.message}`);
  }
  const token = created.body.authorization as string;
  const { body: { controls }} = await call('GET', `${base}.account/`, undefined, token);
  await call('POST', controls.password.create, { email: `${name}-${run}@example.invalid`, password: `${name}-password-1` }, token);
  return { token, controls };
}

async function provisionerPass(): Promise<{ provisioned: number; deprovisioned: number; failed: number }> {
  const proc = Bun.spawnSync([ 'bun', 'packages/broker/src/provisioner.ts', '--once' ], {
    env: {
      ...process.env,
      BROKER_URL: brokerUrl,
      BROKER_PROVISIONER_KEY: provisionerKey,
      TENANT_ID: 'mock-tenant-id',
      TENANT_CLIENT_ID: brokerApp,
      PROVISIONER_CLIENT_ID: 'ubisolid-provisioner',
      PROVISIONER_CLIENT_SECRET: 'mock-admin-secret',
      TENANT_LOGIN_URL: mock,
      TENANT_GRAPH_URL: mock,
    },
  });
  const lines = proc.stdout.toString().trim().split('\n');
  if (proc.stderr.length) {
    console.log(proc.stderr.toString().trim());
  }
  return JSON.parse(lines.at(-1) ?? '{}');
}

async function mockDrives(): Promise<any[]> {
  return (await fetch(`${mock}/mock/drives`)).json() as Promise<any[]>;
}

const [ code ] = (process.env.E2E_CODES ?? 'SEED-TEST-CODE-0001').split(',');
const carol = await signUp(code, 'carol');
const storageUrl = carol.controls.account.storage;

const view = await call('GET', storageUrl, undefined, carol.token);
check('tenant mode is offered', view.body.providers?.includes('onedrive-tenant'), JSON.stringify(view.body.providers));

// Sign-in: identity only. The authorize URL points at the mock by its in-network name; reach it from here instead.
const start = await call('POST', storageUrl, { provider: 'onedrive-tenant' }, carol.token);
const authorize = new URL(start.body.authorizeUrl);
check('the sign-in asks for identity only, with PKCE',
  authorize.searchParams.get('scope') === 'openid profile email' && authorize.searchParams.get('code_challenge_method') === 'S256',
  authorize.searchParams.get('scope') ?? '');
authorize.host = new URL(mock).host;
authorize.searchParams.set('login_hint', `carol${run}`);
const redirect = await fetch(authorize, { redirect: 'manual' });
const callback = new URL(redirect.headers.get('location')!);
const done = await call('POST', storageUrl, { code: callback.searchParams.get('code'), state: callback.searchParams.get('state') }, carol.token);
const link = done.body.link;
check('after sign-in the link waits for provisioning', done.status === 200 && link?.status === 'pending' && link?.mode === 'tenant', JSON.stringify(done.body).slice(0, 200));

const early = await call('POST', carol.controls.account.pod, { name: `early${run}`, settings: { linkId: link.linkId } }, carol.token);
check('no pod can be created before the folder is provisioned', early.status >= 400, String(early.status));

// Keys are separate: CSS's key can't drive provisioning, the provisioner's can't get tokens.
check('the service key cannot read the provisioning queue',
  (await call('GET', `${brokerUrl}/tenant/queue`, undefined, `Bearer ${serviceKey}`)).status === 401);
check('the provisioner key cannot get pod tokens',
  (await call('POST', `${brokerUrl}/links/${link.linkId}/token`, { podBase: `${base}x/` }, `Bearer ${provisionerKey}`)).status === 401);

const pass1 = await provisionerPass();
check('the provisioning job sets up the folder', pass1.provisioned >= 1 && pass1.failed === 0, JSON.stringify(pass1));
const links = (await call('GET', storageUrl, undefined, carol.token)).body.links;
check('the link is active', links.find((l: any) => l.linkId === link.linkId)?.status === 'active');

const drive = (await mockDrives()).find((d) => d.owner === `oid-carol${run}`);
const folder = drive?.items.find((i: any) => i.name === 'UbiSolid' && i.parent === drive.root);
check('carol\'s OneDrive has a UbiSolid folder with a write grant for the broker app only',
  folder?.grants?.[brokerApp]?.role === 'write' && Object.keys(folder.grants).length === 1, JSON.stringify(folder?.grants));

const podName = `tn${run}`;
const pod = await call('POST', carol.controls.account.pod, { name: podName, settings: { linkId: link.linkId } }, carol.token);
check('carol creates a pod in her work OneDrive', pod.status === 200, JSON.stringify(pod.body).slice(0, 200));
const card = await fetch(`${base}${podName}/profile/card`);
check('the pod is served', card.status === 200, String(card.status));
const after = (await mockDrives()).find((d) => d.owner === `oid-carol${run}`);
const podFolder = after.items.find((i: any) => i.name === podName);
check('its files are in the granted folder', podFolder?.parent === folder.id &&
  after.items.some((i: any) => i.name === 'card$.ttl'));

// Confinement: the app token CSS holds reaches the granted folder and nothing else.
const issued = await call('POST', `${brokerUrl}/links/${link.linkId}/token`, { podBase: `${base}${podName}/` }, `Bearer ${serviceKey}`);
const appToken = `Bearer ${issued.body.accessToken}`;
check('tokens come with the drive and folder', issued.body.location?.driveId === drive.id && issued.body.location?.folderId === folder.id);
const rootList = await fetch(`${mock}/v1.0/drives/${drive.id}/root/children`, { headers: { authorization: appToken } });
check('the app cannot list the rest of carol\'s drive', rootList.status === 403, String(rootList.status));
const outside = await fetch(`${mock}/v1.0/drives/${drive.id}/root:/Documents/secret.txt:/content`,
  { method: 'PUT', headers: { authorization: appToken }, body: 'x' });
check('the app cannot write outside its folder', outside.status === 403, String(outside.status));
const other = await call('GET', `${mock}/v1.0/users/oid-someone-else/drive`, undefined, appToken);
check('the app cannot look up other users\' drives', other.status === 403, String(other.status));

// The storage contract, through the tenant adapter, with the broker's app token.
const conformance = Bun.spawnSync([ 'bun', 'test/adapter-conformance.ts', 'onedrive-tenant' ], {
  env: { ...process.env, TENANT_GRAPH_URL: mock, ACCESS_TOKEN: issued.body.accessToken, LOCATION: JSON.stringify(issued.body.location) },
});
const conformanceOut = conformance.stdout.toString();
check('the tenant adapter passes the conformance suite', conformanceOut.includes('all passed'),
  conformanceOut.split('\n').filter((l) => l.startsWith('FAIL')).join('; '));

// Disconnect: pods go offline at once; the job removes the grant; the files stay.
const unlink = await call('POST', storageUrl, { unlink: link.linkId }, carol.token);
check('carol disconnects; removing the grant is queued', unlink.body.revokedAtProvider === 'queued', JSON.stringify(unlink.body).slice(0, 120));
const offline = await fetch(`${base}${podName}/profile/card`);
check('the pod answers 503 straight away', offline.status === 503, String(offline.status));
const pass2 = await provisionerPass();
check('the provisioning job removes the grant', pass2.deprovisioned >= 1 && pass2.failed === 0, JSON.stringify(pass2));
const final = (await mockDrives()).find((d) => d.owner === `oid-carol${run}`);
const finalFolder = final.items.find((i: any) => i.id === folder.id);
check('the broker app has no grant left', Object.keys(finalFolder?.grants ?? {}).length === 0, JSON.stringify(finalFolder?.grants));
check('carol\'s files are still there', final.items.some((i: any) => i.name === podName));
const deniedNow = await fetch(`${mock}/v1.0/drives/${drive.id}/items/${folder.id}/children`, { headers: { authorization: appToken } });
check('the old app token no longer reaches the folder', deniedNow.status === 403, String(deniedNow.status));
const status = (await call('GET', storageUrl, undefined, carol.token)).body.links.find((l: any) => l.linkId === link.linkId);
check('the link shows as disconnected', status?.status === 'revoked', status?.status);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
