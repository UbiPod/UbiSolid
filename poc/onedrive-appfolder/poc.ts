// OneDrive app-folder POC for a BYO-storage Solid pod backend.
//
// Answers, against a real personal Microsoft account:
//   Q1  Does Files.ReadWrite.AppFolder work for personal (consumer) accounts,
//       and does it really confine the app to Apps/<app>?
//   Q2  Does PUT .../content honour If-Match (412 on a stale eTag)?
//       Also: If-None-Match: * for create-only, If-Match on DELETE, cTag vs eTag.
//   Q3  Refresh-token rotation: does each refresh return a new refresh token,
//       and does the previous one keep working?
//   Q4  Does delta (a change feed) work on the app folder?
//
// Usage: MS_CLIENT_ID=<app id> bun poc.ts
// Tokens are held in memory only and never printed. Results go to stdout and results.json.

const CLIENT_ID = process.env.MS_CLIENT_ID;
// 'consumers' = personal accounts, 'organizations' = work/school, 'common' = both, or a tenant ID.
const AUTHORITY = process.env.MS_AUTHORITY ?? 'common';
const SCOPE = 'Files.ReadWrite.AppFolder offline_access';
const LOGIN = `https://login.microsoftonline.com/${AUTHORITY}/oauth2/v2.0`;
const GRAPH = 'https://graph.microsoft.com/v1.0';

if (!CLIENT_ID) {
  console.error('Set MS_CLIENT_ID to the application (client) ID of your app registration.');
  process.exit(2);
}

type Check = { id: string; question: string; pass: boolean | null; detail: string };
const checks: Check[] = [];
const record = (id: string, question: string, pass: boolean | null, detail: string) => {
  checks.push({ id, question, pass, detail });
  const mark = pass === null ? 'INFO' : pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${id} ${question}\n       ${detail}`);
};

type TokenSet = { access_token: string; refresh_token?: string; expires_in: number; scope: string };

async function form(url: string, body: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function deviceLogin(): Promise<TokenSet> {
  const dc = await form(`${LOGIN}/devicecode`, { client_id: CLIENT_ID!, scope: SCOPE });
  if (dc.status !== 200) throw new Error(`devicecode ${dc.status}: ${dc.json.error}: ${dc.json.error_description}`);
  console.log(`\n>>> ${dc.json.message}\n`);
  let interval = Number(dc.json.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(dc.json.expires_in) * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(interval);
    const t = await form(`${LOGIN}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID!,
      device_code: dc.json.device_code,
    });
    if (t.status === 200) return t.json;
    if (t.json.error === 'authorization_pending') continue;
    if (t.json.error === 'slow_down') { interval += 5000; continue; }
    throw new Error(`token ${t.status}: ${t.json.error}: ${t.json.error_description}`);
  }
  throw new Error('device code expired before sign-in');
}

async function refresh(rt: string) {
  return form(`${LOGIN}/token`, { grant_type: 'refresh_token', client_id: CLIENT_ID!, refresh_token: rt, scope: SCOPE });
}

let accessToken = '';
async function graph(method: string, path: string, opts: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(opts.headers ?? {}) },
    body: opts.body,
  });
  const text = await res.text();
  let json: any = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const errOf = (r: { json?: any; text: string }) => r.json?.error ? `${r.json.error.code}: ${r.json.error.message}` : r.text.slice(0, 200);

async function main() {
  console.log(`Authority: ${AUTHORITY}  Scope: ${SCOPE}`);
  const t1 = await deviceLogin();
  accessToken = t1.access_token;

  // ---- Q1: app folder on a personal account --------------------------------
  record('Q1a', 'Consent granted the app-folder scope?', /Files\.ReadWrite\.AppFolder/i.test(t1.scope), `granted scope: "${t1.scope}"`);

  const drive = await graph('GET', '/me/drive');
  record('Q1b', 'Which kind of OneDrive (personal = consumer, business = JMU work account)?', drive.status === 200 ? null : false,
    drive.status === 200 ? `driveType=${drive.json.driveType}` : `GET /me/drive -> ${drive.status} ${errOf(drive)}`);

  const approot = await graph('GET', '/me/drive/special/approot');
  record('Q1c', 'GET /me/drive/special/approot works?', approot.status === 200,
    approot.status === 200 ? `folder "${approot.json.name}", parent path ${approot.json.parentReference?.path ?? '?'}` : `${approot.status} ${errOf(approot)}`);
  if (approot.status !== 200) return;

  // Listing the root may succeed but show only the path down to the app folder. Report what is visible
  // (names other than "Apps" are counted, not printed), then try to write and read outside the app folder.
  const outside = await graph('GET', '/me/drive/root/children?$top=200&$select=name,folder');
  const names: string[] = outside.status === 200 ? outside.json.value.map((i: any) => i.name) : [];
  const others = names.filter((n) => n !== 'Apps').length;
  record('Q1d', 'Root listing shows nothing but the Apps folder?', outside.status >= 400 ? true : others === 0,
    `GET /me/drive/root/children -> ${outside.status}${outside.status >= 400 ? ' ' + errOf(outside) : `; ${names.length} visible item(s): ${names.includes('Apps') ? '"Apps" + ' : ''}${others} other(s)`}`);

  const appsKids = await graph('GET', '/me/drive/root:/Apps:/children?$top=200&$select=name');
  const appsNames: string[] = appsKids.status === 200 ? appsKids.json.value.map((i: any) => i.name) : [];
  record('Q1e', 'Apps/ shows only this app\'s folder?', appsKids.status >= 400 ? true : appsNames.length <= 1,
    `GET /me/drive/root:/Apps:/children -> ${appsKids.status}${appsKids.status >= 400 ? ' ' + errOf(appsKids) : `; ${appsNames.length} item(s)${appsNames.length <= 1 ? `: ${appsNames.join(', ')}` : ' (other apps\' folders visible)'}`}`);

  const probe = `poc-outside-${Date.now()}.txt`;
  const wOut = await graph('PUT', `/me/drive/root:/${probe}:/content`, { body: 'outside', headers: { 'Content-Type': 'text/plain' } });
  record('Q1f', 'Writing to the drive root is refused?', [401, 403, 404].includes(wOut.status),
    `PUT /me/drive/root:/${probe} -> ${wOut.status}${wOut.status >= 400 ? ' ' + errOf(wOut) : ' (WROTE outside the app folder; deleting it)'}`);
  if (wOut.status < 300) await graph('DELETE', `/me/drive/root:/${probe}:`);

  const search = await graph('GET', "/me/drive/root/search(q='a')?$top=50&$select=name,parentReference");
  const hits = search.status === 200 ? search.json.value.filter((i: any) => !String(i.parentReference?.path ?? '').includes('/Apps/')).length : 0;
  record('Q1g', 'Search finds nothing outside the app folder?', search.status >= 400 ? true : hits === 0,
    `GET /me/drive/root/search(q='a') -> ${search.status}${search.status >= 400 ? ' ' + errOf(search) : `; ${hits} hit(s) outside Apps/`}`);

  // ---- Q2: conditional writes ------------------------------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `/me/drive/special/approot:/poc-${stamp}/doc.ttl:/content`;
  const item = (p: string) => p.replace(/:\/content$/, ':');
  const put = (body: string, headers: Record<string, string> = {}) =>
    graph('PUT', file, { body, headers: { 'Content-Type': 'text/turtle', ...headers } });

  const v1 = await put('<#a> <#b> "v1".');
  record('Q2a', 'Create file in app folder', v1.status === 201 || v1.status === 200, `PUT -> ${v1.status}, eTag=${v1.json?.eTag}, cTag=${v1.json?.cTag}`);
  if (v1.status >= 300) return;

  const v2 = await put('<#a> <#b> "v2".', { 'If-Match': v1.json.eTag });
  record('Q2b', 'PUT with current eTag in If-Match succeeds', v2.status === 200, `-> ${v2.status}${v2.status >= 300 ? ' ' + errOf(v2) : `, new eTag=${v2.json.eTag}`}`);

  const stale = await put('<#a> <#b> "lost update".', { 'If-Match': v1.json.eTag });
  record('Q2c', 'PUT with STALE eTag is refused with 412', stale.status === 412, `-> ${stale.status}${stale.status >= 300 ? ' ' + errOf(stale) : ' (OVERWROTE the newer version)'}`);

  const afterStale = await graph('GET', file);
  record('Q2d', 'Content after the stale PUT is still v2', afterStale.text.includes('"v2"'), `content now: ${afterStale.text.slice(0, 60)}`);

  const current = await graph('GET', item(file));
  const staleCtag = await put('<#a> <#b> "ctag test".', { 'If-Match': v1.json.cTag });
  record('Q2e', 'If-Match with a stale cTag is refused with 412', staleCtag.status === 412, `-> ${staleCtag.status}${staleCtag.status >= 300 ? ' ' + errOf(staleCtag) : ''}`);

  const createOnly = await put('<#a> <#b> "clobber".', { 'If-None-Match': '*' });
  record('Q2f', 'If-None-Match: * on an existing file is refused (create-only writes)', createOnly.status === 412 || createOnly.status === 409,
    `-> ${createOnly.status}${createOnly.status >= 300 ? ' ' + errOf(createOnly) : ' (overwrote)'}`);

  const conflictBehavior = await graph('PUT', `${file}?@microsoft.graph.conflictBehavior=fail`, {
    body: '<#a> <#b> "fail-mode".', headers: { 'Content-Type': 'text/turtle' },
  });
  record('Q2g', 'conflictBehavior=fail on an existing file refuses (alternative create-only)', conflictBehavior.status === 409 || conflictBehavior.status === 412,
    `-> ${conflictBehavior.status}${conflictBehavior.status >= 300 ? ' ' + errOf(conflictBehavior) : ' (overwrote)'}`);

  const now = await graph('GET', item(file));
  const delStale = await graph('DELETE', item(file), { headers: { 'If-Match': v1.json.eTag } });
  record('Q2h', 'DELETE with stale eTag is refused with 412', delStale.status === 412, `-> ${delStale.status}${delStale.status >= 300 ? ' ' + errOf(delStale) : ' (deleted)'}`);

  record('Q2i', 'eTag changes on every content write', null,
    `v1=${v1.json.eTag} v2=${v2.json?.eTag ?? '?'} before-delete=${now.json?.eTag ?? '?'} (current at Q2e: ${current.json?.eTag ?? '?'})`);

  // ---- Q4: change feed on the app folder ---------------------------------------
  const delta = await graph('GET', `/me/drive/items/${approot.json.id}/delta`);
  record('Q4a', 'delta works on the app folder', delta.status === 200,
    delta.status === 200 ? `${delta.json.value?.length ?? 0} items, deltaLink present: ${Boolean(delta.json['@odata.deltaLink'])}` : `${delta.status} ${errOf(delta)}`);

  // cleanup (unconditional)
  const del = await graph('DELETE', `/me/drive/special/approot:/poc-${stamp}:`);
  record('cleanup', 'Delete the POC folder', del.status === 204, `-> ${del.status}`);

  // ---- Q3: refresh-token rotation ----------------------------------------------
  const rt1 = t1.refresh_token;
  if (!rt1) { record('Q3a', 'Got a refresh token (offline_access)', false, 'no refresh_token in token response'); return; }
  const r2 = await refresh(rt1);
  const rt2 = r2.json.refresh_token as string | undefined;
  record('Q3a', 'Refresh returns a NEW refresh token (rotation)', r2.status === 200 && !!rt2 && rt2 !== rt1,
    `-> ${r2.status}${r2.status !== 200 ? ' ' + r2.json.error : ''}; new RT returned: ${!!rt2}; differs from previous: ${rt2 !== rt1}`);
  if (r2.status === 200) record('Q3b', 'Access token lifetime', null, `expires_in=${r2.json.expires_in}s; refresh_token_expires_in=${r2.json.refresh_token_expires_in ?? 'not stated'}`);

  const reuse = await refresh(rt1);
  record('Q3c', 'The PREVIOUS refresh token still works after rotation', null,
    reuse.status === 200 ? 'yes: old RT redeemed again (old tokens are not revoked on rotation; the broker must delete them itself)'
      : `no: ${reuse.status} ${reuse.json.error}: ${String(reuse.json.error_description).split('\r')[0]}`);

  if (rt2) {
    const r3 = await refresh(rt2);
    record('Q3d', 'The rotated refresh token works', r3.status === 200, `-> ${r3.status}${r3.status !== 200 ? ' ' + r3.json.error : ''}`);
  }
}

try {
  await main();
} catch (e) {
  record('fatal', 'Run aborted', false, String(e));
}
await Bun.write('results.json', JSON.stringify({ at: new Date().toISOString(), authority: AUTHORITY, scope: SCOPE, checks }, null, 2));
console.log('\nWrote results.json');
