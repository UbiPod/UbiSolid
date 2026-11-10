import { Readable } from 'node:stream';
import { NotFoundHttpError } from '@solid/community-server';
import type { CloudAdapter, CloudFs, CloudStat } from '../CloudFs';
import { asBody, baseName, joinRoot, parentOf } from '../CloudFs';
import { failure, providerFetch } from './http';

/** GRAPH_URL points the adapters at a mock in tests. */
const GRAPH = `${process.env.GRAPH_URL ?? 'https://graph.microsoft.com'}/v1.0`;
const DRIVE = `${GRAPH}/me/drive`;
const APPROOT = `${DRIVE}/special/approot`;
/** Tenant mode can point at a different Graph (a mock) than personal OneDrive. */
const TENANT_GRAPH = `${process.env.TENANT_GRAPH_URL ?? process.env.GRAPH_URL ?? 'https://graph.microsoft.com'}/v1.0`;
const SELECT = '$select=name,size,lastModifiedDateTime,folder,file,eTag';

interface DriveItem {
  name: string;
  size?: number;
  lastModifiedDateTime: string;
  folder?: unknown;
  eTag?: string;
}

function toStat(item: DriveItem): CloudStat {
  return {
    name: item.name,
    isDirectory: Boolean(item.folder),
    size: item.size ?? 0,
    mtime: new Date(item.lastModifiedDateTime),
    version: item.eTag,
  };
}

/** Graph path addressing below a base item: approot:/a/b: or items/{id}:/a/b: */
function itemUrl(base: string, path: string): string {
  if (path === '/') {
    return base;
  }
  return `${base}:${path.split('/').map(encodeURIComponent).join('/')}:`;
}

/**
 * The CloudFs for anything addressed below one Graph folder.
 * @param base - The folder: the app folder, or a granted folder in tenant mode.
 * @param drive - Its drive, for item-id addressing (folder creation only works that way).
 */
function graphFs(accessToken: string, root: string, base: string, drive: string): CloudFs {
  const auth = { authorization: `Bearer ${accessToken}` };
  const full = (path: string): string => joinRoot(root, path);

  const stat = async(path: string): Promise<CloudStat | undefined> => {
    const res = await providerFetch(`${itemUrl(base, full(path))}?${SELECT}`, { headers: auth }, 'OneDrive stat');
    if (res.status === 404) {
      await res.body?.cancel();
      return undefined;
    }
    if (!res.ok) {
      return failure(res, 'OneDrive stat');
    }
    return toStat(await res.json() as DriveItem);
  };

  const mkdirp = async(path: string): Promise<void> => {
    const target = full(path);
    if (target === '/') {
      // The base folder: the app folder (created by Graph on first access), or the granted folder.
      const res = await providerFetch(base, { headers: auth }, 'OneDrive approot');
      if (!res.ok) {
        return failure(res, 'OneDrive approot');
      }
      await res.body?.cancel();
      return;
    }
    // Graph rejects POST .../special/approot[:/path:]/children with 400 invalidRequest
    // (verified live), so look up the parent's item id and create through /items/{id}.
    const parentId = async(): Promise<string | undefined> => {
      const res = await providerFetch(`${itemUrl(base, parentOf(target))}?$select=id`, { headers: auth }, 'OneDrive mkdir');
      if (res.status === 404) {
        await res.body?.cancel();
        return undefined;
      }
      if (!res.ok) {
        return failure(res, 'OneDrive mkdir');
      }
      return (await res.json() as { id: string }).id;
    };
    let id = await parentId();
    if (!id) {
      // Parent missing: create it relative to the pod root, then retry.
      await mkdirp(parentOf(path));
      id = await parentId();
      if (!id) {
        return failure(new Response('parent folder vanished', { status: 409 }), 'OneDrive mkdir');
      }
    }
    const res = await providerFetch(`${drive}/items/${encodeURIComponent(id)}/children`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: baseName(target), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    }, 'OneDrive mkdir');
    if (res.status === 409) {
      // Already exists. Make sure it is a folder.
      await res.body?.cancel();
      const existing = await stat(path);
      if (!existing?.isDirectory) {
        return failure(new Response('a file is in the way', { status: 409 }), 'OneDrive mkdir');
      }
      return;
    }
    if (!res.ok) {
      return failure(res, 'OneDrive mkdir');
    }
    await res.body?.cancel();
  };

  return {
    stat,
    mkdirp,

    read: async(path) => {
      // Graph answers with a redirect to a pre-authenticated download URL; fetch follows it
      // and drops the Authorization header on the cross-origin hop.
      const res = await providerFetch(`${itemUrl(base, full(path))}/content`, { headers: auth }, 'OneDrive read');
      if (!res.ok || !res.body) {
        return failure(res, 'OneDrive read');
      }
      return Readable.fromWeb(res.body as any);
    },

    list: async(path) => {
      const out: CloudStat[] = [];
      let next: string | undefined = `${itemUrl(base, full(path))}/children?${SELECT}&$top=1000`;
      while (next) {
        const res: Response = await providerFetch(next, { headers: auth }, 'OneDrive list');
        if (res.status === 404) {
          await res.body?.cancel();
          throw new NotFoundHttpError();
        }
        if (!res.ok) {
          return failure(res, 'OneDrive list');
        }
        const page = await res.json() as { value: DriveItem[]; '@odata.nextLink'?: string };
        out.push(...page.value.map(toStat));
        next = page['@odata.nextLink'];
      }
      return out;
    },

    write: async(path, data, ifVersion) => {
      // Simple upload, up to 250 MB. Graph creates missing parent folders for path-addressed PUTs.
      const res = await providerFetch(`${itemUrl(base, full(path))}/content`, {
        method: 'PUT',
        headers: {
          ...auth,
          'content-type': 'application/octet-stream',
          ...ifVersion ? { 'if-match': ifVersion } : {},
        },
        body: asBody(data),
      }, 'OneDrive write');
      if (!res.ok) {
        return failure(res, 'OneDrive write');
      }
      return toStat(await res.json() as DriveItem);
    },

    remove: async(path) => {
      const target = full(path);
      if (target === '/') {
        throw new Error('Refusing to delete the whole app folder.');
      }
      const res = await providerFetch(itemUrl(base, target), { method: 'DELETE', headers: auth }, 'OneDrive delete');
      if (!res.ok && res.status !== 404) {
        return failure(res, 'OneDrive delete');
      }
      await res.body?.cancel();
    },
  };
}

/**
 * OneDrive app folder (Files.ReadWrite.AppFolder) through Microsoft Graph.
 * POC-verified behaviour: If-Match is honoured on PUT and DELETE (412), If-None-Match is not,
 * and conflictBehavior=fail gives 409 for create-only.
 */
export class OneDriveAdapter implements CloudAdapter {
  public readonly provider = 'onedrive';

  public open(accessToken: string, root: string): CloudFs {
    return graphFs(accessToken, root, APPROOT, DRIVE);
  }
}

/**
 * Tenant mode: the broker's app-only token, confined by Files.SelectedOperations.Selected to the folder
 * an administrator granted it in the owner's work OneDrive. The broker says which drive and folder.
 * Prototype: tested against test/mock-graph.ts only.
 */
export class OneDriveTenantAdapter implements CloudAdapter {
  public readonly provider = 'onedrive-tenant';

  public open(accessToken: string, root: string, location?: Record<string, string>): CloudFs {
    if (!location?.driveId || !location.folderId) {
      throw new Error('Tenant mode needs the drive and folder from the broker.');
    }
    const drive = `${TENANT_GRAPH}/drives/${encodeURIComponent(location.driveId)}`;
    return graphFs(accessToken, root, `${drive}/items/${encodeURIComponent(location.folderId)}`, drive);
  }
}
