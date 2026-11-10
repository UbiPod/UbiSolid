// A stand-in for login.microsoftonline.com and graph.microsoft.com, for testing tenant mode without a tenant.
//
// It models what tenant mode relies on, as Microsoft documents it (not verified against a real tenant):
//   - client-credentials tokens for apps, and an authorization-code sign-in that returns an ID token
//   - Files.SelectedOperations.Selected: an app sees nothing until it has a role on an item;
//     a role on a folder covers everything below it
//   - admin apps (the provisioning job) can create folders in any user's drive and grant roles
//   - driveItem addressing by id and by id-relative path, If-Match (412), conflictBehavior=fail (409)
//
//   MOCK_GRAPH_PORT=8700 MOCK_TENANT=contoso-tid MOCK_ADMIN_CLIENTS=provisioner bun test/mock-graph.ts
import { randomBytes, randomUUID } from 'node:crypto';

const port = Number(process.env.MOCK_GRAPH_PORT ?? 8700);
const tenant = process.env.MOCK_TENANT ?? 'mock-tenant-id';
const adminClients = new Set((process.env.MOCK_ADMIN_CLIENTS ?? 'provisioner').split(','));
const publicUrl = process.env.MOCK_PUBLIC_URL ?? `http://localhost:${port}`;

interface Item {
  id: string;
  name: string;
  parent?: string;
  folder: boolean;
  data?: Uint8Array;
  etag: string;
  modified: string;
  /** appId -> role, with the permission id. */
  grants: Map<string, { role: string; permissionId: string }>;
}
interface Drive {
  id: string;
  owner: string;
  root: string;
  items: Map<string, Item>;
}

const drives = new Map<string, Drive>();
const tokens = new Map<string, { appId?: string; admin?: boolean; user?: string }>();
const stats = { requests: 0, denied: 0 };

function newItem(name: string, folder: boolean, parent?: string): Item {
  return { id: randomUUID(), name, parent, folder, etag: `"{${randomUUID()}},1"`, modified: new Date().toISOString(), grants: new Map() };
}

function driveFor(user: string): Drive {
  let drive = [ ...drives.values() ].find((d) => d.owner === user);
  if (!drive) {
    const root = newItem('root', true);
    drive = { id: `b!${randomBytes(6).toString('hex')}`, owner: user, root: root.id, items: new Map([[ root.id, root ]]) };
    drives.set(drive.id, drive);
  }
  return drive;
}

function children(drive: Drive, id: string): Item[] {
  return [ ...drive.items.values() ].filter((i) => i.parent === id);
}

function child(drive: Drive, id: string, name: string): Item | undefined {
  return children(drive, id).find((i) => i.name.toLowerCase() === name.toLowerCase());
}

function walk(drive: Drive, startId: string, path: string): Item | undefined {
  let item = drive.items.get(startId);
  for (const part of path.split('/').filter(Boolean)) {
    if (!item) {
      return undefined;
    }
    item = child(drive, item.id, decodeURIComponent(part));
  }
  return item;
}

/** The app's role on an item: its own grant or the nearest ancestor's. */
function roleOf(drive: Drive, item: Item | undefined, appId: string): string | undefined {
  for (let current = item; current; current = current.parent ? drive.items.get(current.parent) : undefined) {
    const grant = current.grants.get(appId);
    if (grant) {
      return grant.role;
    }
  }
  return undefined;
}

function touch(item: Item): void {
  const version = Number(item.etag.split(',')[1]?.replace('"', '') ?? 1) + 1;
  item.etag = `"{${item.id}},${version}"`;
  item.modified = new Date().toISOString();
}

function view(drive: Drive, item: Item): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    eTag: item.etag,
    lastModifiedDateTime: item.modified,
    size: item.data?.length ?? 0,
    parentReference: { driveId: drive.id, id: item.parent },
    ...item.folder ? { folder: { childCount: children(drive, item.id).length } } : { file: {} },
  };
}

const error = (status: number, code: string, message = code): Response =>
  Response.json({ error: { code, message } }, { status });

function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.`;
}

async function login(req: Request, url: URL): Promise<Response> {
  if (url.pathname.endsWith('/authorize')) {
    // Signs in whoever login_hint names (default "alice"), as a user of the mock tenant.
    const target = new URL(url.searchParams.get('redirect_uri')!);
    target.searchParams.set('code', `mockcode.${url.searchParams.get('login_hint') || 'alice'}`);
    target.searchParams.set('state', url.searchParams.get('state') ?? '');
    return Response.redirect(target.href, 302);
  }
  const form = new URLSearchParams(await req.text());
  const clientId = form.get('client_id') ?? '';
  if (!form.get('client_secret') && !form.get('client_assertion')) {
    return Response.json({ error: 'invalid_client', error_description: 'credentials missing' }, { status: 401 });
  }
  if (form.get('grant_type') === 'client_credentials') {
    const token = `mock-app.${clientId}.${randomBytes(8).toString('hex')}`;
    tokens.set(token, { appId: clientId, admin: adminClients.has(clientId) });
    return Response.json({ access_token: token, expires_in: 3599, token_type: 'Bearer' });
  }
  if (form.get('grant_type') === 'authorization_code') {
    const user = (form.get('code') ?? '').replace(/^mockcode\./u, '');
    const oid = `oid-${user}`;
    driveFor(oid);
    const token = `mock-user.${user}.${randomBytes(8).toString('hex')}`;
    tokens.set(token, { user: oid });
    return Response.json({
      access_token: token,
      expires_in: 3599,
      id_token: jwt({ oid, tid: tenant, preferred_username: `${user}@contoso.example`, email: `${user}@contoso.example` }),
    });
  }
  return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
}

async function graph(req: Request, url: URL): Promise<Response> {
  const auth = tokens.get((req.headers.get('authorization') ?? '').replace(/^Bearer /u, ''));
  if (!auth?.appId) {
    return error(401, 'InvalidAuthenticationToken');
  }
  const path = url.pathname.replace(/^\/v1\.0/u, '');
  let m: RegExpMatchArray | null;

  // Admin: a user's drive.
  if ((m = path.match(/^\/users\/([^/]+)\/drive$/u)) && req.method === 'GET') {
    if (!auth.admin) {
      return error(403, 'accessDenied');
    }
    const drive = driveFor(decodeURIComponent(m[1]));
    return Response.json({ id: drive.id, owner: { user: { id: drive.owner } } });
  }

  m = path.match(/^\/drives\/([^/]+)\/(root|items\/([^/:]+))(?::([^:]*):)?(\/children|\/content|\/permissions(?:\/([^/]+))?)?$/u);
  if (!m) {
    return error(400, 'invalidRequest', `mock-graph doesn't know ${req.method} ${path}`);
  }
  const drive = drives.get(decodeURIComponent(m[1]));
  if (!drive) {
    return error(404, 'itemNotFound');
  }
  const startId = m[2] === 'root' ? drive.root : decodeURIComponent(m[3]);
  const relPath = m[4];
  const tail = m[5] ?? '';
  const target = relPath ? walk(drive, startId, relPath) : drive.items.get(startId);
  const parentOfTarget = relPath ? walk(drive, startId, relPath.split('/').slice(0, -1).join('/')) : undefined;

  // Access check. Admin apps reach everything. Others need a role on the item or an ancestor;
  // for something that doesn't exist yet, on its parent.
  const anchor = target ?? parentOfTarget ?? drive.items.get(startId);
  const role = auth.admin ? 'owner' : roleOf(drive, anchor, auth.appId);
  if (!role) {
    stats.denied++;
    return error(403, 'accessDenied', 'The app has no permission on this item.');
  }
  const writing = req.method !== 'GET';
  if (writing && role === 'read') {
    stats.denied++;
    return error(403, 'accessDenied', 'Read-only grant.');
  }

  if (tail.startsWith('/permissions')) {
    if (!auth.admin || !target) {
      return error(auth.admin ? 404 : 403, auth.admin ? 'itemNotFound' : 'accessDenied');
    }
    if (req.method === 'POST') {
      // Microsoft's docs show the older grantedTo shape for Files.SelectedOperations.Selected grants.
      const body = await req.json() as { roles?: string[]; grantedTo?: { application?: { id?: string } } };
      const appId = body.grantedTo?.application?.id;
      const grantRole = body.roles?.[0];
      if (!appId || !grantRole || ![ 'read', 'write', 'owner' ].includes(grantRole)) {
        return error(400, 'invalidRequest', 'need roles and grantedTo.application.id');
      }
      const permissionId = `perm-${randomBytes(6).toString('hex')}`;
      target.grants.set(appId, { role: grantRole, permissionId });
      return Response.json({ id: permissionId, roles: [ grantRole ], grantedTo: { application: { id: appId } } }, { status: 201 });
    }
    if (req.method === 'DELETE' && m[6]) {
      for (const [ appId, grant ] of target.grants) {
        if (grant.permissionId === m[6]) {
          target.grants.delete(appId);
          return new Response(null, { status: 204 });
        }
      }
      return error(404, 'itemNotFound');
    }
    if (req.method === 'GET') {
      return Response.json({ value: [ ...target.grants ].map(([ appId, g ]) => ({ id: g.permissionId, roles: [ g.role ], grantedTo: { application: { id: appId } } })) });
    }
  }

  if (tail === '/children' && req.method === 'GET') {
    if (!target?.folder) {
      return error(404, 'itemNotFound');
    }
    return Response.json({ value: children(drive, target.id).map((i) => view(drive, i)) });
  }
  if (tail === '/children' && req.method === 'POST') {
    if (!target?.folder) {
      return error(404, 'itemNotFound');
    }
    const body = await req.json() as Record<string, unknown>;
    const name = String(body.name ?? '');
    if (child(drive, target.id, name)) {
      if (body['@microsoft.graph.conflictBehavior'] === 'fail') {
        return error(409, 'nameAlreadyExists');
      }
    }
    const item = newItem(name, Boolean(body.folder), target.id);
    drive.items.set(item.id, item);
    touch(target);
    return Response.json(view(drive, item), { status: 201 });
  }
  if (tail === '/content' && req.method === 'GET') {
    if (!target || target.folder) {
      return error(404, 'itemNotFound');
    }
    return new Response(target.data ?? new Uint8Array());
  }
  if (tail === '/content' && req.method === 'PUT') {
    const ifMatch = req.headers.get('if-match');
    if (ifMatch && (!target || target.etag !== ifMatch)) {
      return error(412, 'preconditionFailed');
    }
    const data = new Uint8Array(await req.arrayBuffer());
    if (target) {
      target.data = data;
      touch(target);
      return Response.json(view(drive, target));
    }
    if (!relPath) {
      return error(404, 'itemNotFound');
    }
    // Path PUTs create missing parent folders, as Graph does.
    let parent = drive.items.get(startId)!;
    const parts = relPath.split('/').filter(Boolean).map(decodeURIComponent);
    for (const part of parts.slice(0, -1)) {
      let next = child(drive, parent.id, part);
      if (!next) {
        next = newItem(part, true, parent.id);
        drive.items.set(next.id, next);
      }
      parent = next;
    }
    const item = newItem(parts.at(-1)!, false, parent.id);
    item.data = data;
    drive.items.set(item.id, item);
    return Response.json(view(drive, item), { status: 201 });
  }
  if (tail === '' && req.method === 'GET') {
    return target ? Response.json(view(drive, target)) : error(404, 'itemNotFound');
  }
  if (tail === '' && req.method === 'DELETE') {
    if (!target) {
      return error(404, 'itemNotFound');
    }
    const ifMatch = req.headers.get('if-match');
    if (ifMatch && target.etag !== ifMatch) {
      return error(412, 'preconditionFailed');
    }
    const doomed = [ target.id ];
    for (let i = 0; i < doomed.length; i++) {
      doomed.push(...children(drive, doomed[i]).map((c) => c.id));
    }
    for (const id of doomed) {
      drive.items.delete(id);
    }
    return new Response(null, { status: 204 });
  }
  return error(400, 'invalidRequest', `mock-graph doesn't know ${req.method} ${path}${tail}`);
}

Bun.serve({
  port,
  async fetch(req) {
    stats.requests++;
    const url = new URL(req.url);
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, ...stats });
    }
    if (url.pathname === '/mock/drives') {
      // Test hook: what's in each drive, and who has grants where.
      return Response.json([ ...drives.values() ].map((d) => ({
        id: d.id,
        owner: d.owner,
        root: d.root,
        items: [ ...d.items.values() ].map((i) => ({ id: i.id, name: i.name, parent: i.parent, folder: i.folder, grants: Object.fromEntries(i.grants) })),
      })));
    }
    if (url.pathname.includes('/oauth2/v2.0/')) {
      return login(req, url);
    }
    if (url.pathname.startsWith('/v1.0/')) {
      return graph(req, url);
    }
    return error(404, 'notFound');
  },
});
console.log(`mock graph on ${publicUrl}, tenant ${tenant}, admin apps: ${[ ...adminClients ].join(', ')}`);
