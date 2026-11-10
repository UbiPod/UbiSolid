// Tenant-mode provisioning job. Runs apart from the broker, with its own admin credential.
//
// For each user waiting in the broker's queue, it creates a folder in their work OneDrive and grants the broker's
// app a role on it (Files.SelectedOperations.Selected). For each disconnected link it removes that grant. The
// broker never holds this job's credential, and this job never gets tokens for pods.
//
// The admin app needs application permissions that can create items in any user's drive and manage item
// permissions (for example Files.ReadWrite.All plus Sites.FullControl.All). Keep its credential off the broker's host.
//
//   bun src/provisioner.ts            # poll every PROVISION_INTERVAL_S (default 30)
//   bun src/provisioner.ts --once     # one pass, e.g. from cron
//
// Prototype: the request shapes follow Microsoft's documentation (the grant uses the older `grantedTo` property)
// and are exercised against test/mock-graph.ts only.
import { clientAuth } from './providers';
import type { ClientCredential } from './providers';

interface Job {
  linkId: string;
  userId: string;
  email?: string;
  location?: { driveId: string; folderId: string; permissionId?: string };
}

const env = process.env;
const need = (name: string): string => {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} must be set.`);
  }
  return value;
};

const brokerUrl = need('BROKER_URL');
const provisionerKey = need('BROKER_PROVISIONER_KEY');
const tenantId = need('TENANT_ID');
const brokerAppId = need('TENANT_CLIENT_ID');
const folderName = env.TENANT_FOLDER_NAME ?? 'UbiSolid';
const role = env.TENANT_GRANT_ROLE ?? 'write';
const graph = `${env.TENANT_GRAPH_URL ?? 'https://graph.microsoft.com'}/v1.0`;
const tokenEndpoint = `${env.TENANT_LOGIN_URL ?? 'https://login.microsoftonline.com'}/${tenantId}/oauth2/v2.0/token`;
const credential: ClientCredential = {
  clientId: need('PROVISIONER_CLIENT_ID'),
  clientSecret: env.PROVISIONER_CLIENT_SECRET,
  certificateKeyPem: env.PROVISIONER_CERT_KEY_FILE ? await Bun.file(env.PROVISIONER_CERT_KEY_FILE).text() : undefined,
  certificateThumbprint: env.PROVISIONER_CERT_THUMBPRINT,
};

let adminToken: { value: string; expiresAt: number } | undefined;
async function token(): Promise<string> {
  if (adminToken && adminToken.expiresAt - 300_000 > Date.now()) {
    return adminToken.value;
  }
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...clientAuth(credential, tokenEndpoint), grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }),
  });
  const body = await res.json() as Record<string, any>;
  if (!res.ok) {
    throw new Error(`admin token: ${res.status} ${body.error_description ?? body.error}`);
  }
  adminToken = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in) * 1000 };
  return adminToken.value;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${graph}${path}`, {
    method,
    headers: { authorization: `Bearer ${await token()}`, ...body ? { 'content-type': 'application/json' } : {} },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function graphJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await call(method, path, body);
  const json = await res.json().catch(() => ({})) as Record<string, any>;
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${json.error?.message ?? ''}`);
  }
  return json as T;
}

async function broker(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${brokerUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${provisionerKey}`, ...body ? { 'content-type': 'application/json' } : {} },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`broker ${method} ${path}: ${res.status} ${json.error ?? ''}`);
  }
  return json;
}

async function provision(job: Job): Promise<void> {
  const drive = await graphJson<{ id: string }>('GET', `/users/${encodeURIComponent(job.userId)}/drive`);
  const driveId = encodeURIComponent(drive.id);
  // The user's folder, created once. If it exists already (a relink), reuse it.
  let folder: { id: string };
  const created = await call('POST', `/drives/${driveId}/root/children`,
    { name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
  if (created.status === 409) {
    folder = await graphJson('GET', `/drives/${driveId}/root:/${encodeURIComponent(folderName)}:`);
  } else if (created.ok) {
    folder = await created.json() as { id: string };
  } else {
    throw new Error(`create folder: ${created.status} ${await created.text()}`);
  }
  const permission = await graphJson<{ id: string }>('POST', `/drives/${driveId}/items/${encodeURIComponent(folder.id)}/permissions`, {
    roles: [ role ],
    grantedTo: { application: { id: brokerAppId } },
  });
  await broker('POST', `/tenant/links/${job.linkId}/activate`, { driveId: drive.id, folderId: folder.id, permissionId: permission.id });
  console.log(`provisioned ${job.email ?? job.userId}: folder ${folderName}, ${role} for the broker app`);
}

async function deprovision(job: Job): Promise<void> {
  const loc = job.location;
  if (loc?.permissionId) {
    const res = await call('DELETE',
      `/drives/${encodeURIComponent(loc.driveId)}/items/${encodeURIComponent(loc.folderId)}/permissions/${encodeURIComponent(loc.permissionId)}`);
    if (!res.ok && res.status !== 404) {
      throw new Error(`remove grant: ${res.status} ${await res.text()}`);
    }
  }
  // The folder and its files stay in the user's OneDrive.
  await broker('POST', `/tenant/links/${job.linkId}/revoked`);
  console.log(`deprovisioned ${job.userId}: grant removed, files left in place`);
}

export async function runOnce(): Promise<{ provisioned: number; deprovisioned: number; failed: number }> {
  const queue = await broker('GET', '/tenant/queue') as { provision: Job[]; deprovision: Job[] };
  const result = { provisioned: 0, deprovisioned: 0, failed: 0 };
  for (const job of queue.provision) {
    try {
      await provision(job);
      result.provisioned++;
    } catch (error) {
      result.failed++;
      console.error(`provision ${job.linkId} failed: ${(error as Error).message}`);
    }
  }
  for (const job of queue.deprovision) {
    try {
      await deprovision(job);
      result.deprovisioned++;
    } catch (error) {
      result.failed++;
      console.error(`deprovision ${job.linkId} failed: ${(error as Error).message}`);
    }
  }
  return result;
}

if (import.meta.main) {
  if (process.argv.includes('--once')) {
    console.log(JSON.stringify(await runOnce()));
  } else {
    const interval = Number(env.PROVISION_INTERVAL_S ?? 30) * 1000;
    for (;;) {
      await runOnce().catch((error) => console.error(error));
      await Bun.sleep(interval);
    }
  }
}
