import { Readable } from 'node:stream';
import { NotFoundHttpError } from '@solid/community-server';
import type { CloudAdapter, CloudFs, CloudStat } from '../CloudFs';
import { asBody, baseName, joinRoot, parentOf } from '../CloudFs';
import { failure, providerFetch } from './http';

const APPROOT = 'https://graph.microsoft.com/v1.0/me/drive/special/approot';
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

/** Graph path addressing inside the app folder: approot:/a/b: */
function itemUrl(path: string): string {
  if (path === '/') {
    return APPROOT;
  }
  return `${APPROOT}:${path.split('/').map(encodeURIComponent).join('/')}:`;
}

/**
 * OneDrive app folder (Files.ReadWrite.AppFolder) through Microsoft Graph.
 * POC-verified behaviour: If-Match is honoured on PUT and DELETE (412), If-None-Match is not,
 * and conflictBehavior=fail gives 409 for create-only.
 */
export class OneDriveAdapter implements CloudAdapter {
  public readonly provider = 'onedrive';

  public open(accessToken: string, root: string): CloudFs {
    const auth = { authorization: `Bearer ${accessToken}` };
    const full = (path: string): string => joinRoot(root, path);

    const stat = async(path: string): Promise<CloudStat | undefined> => {
      const res = await providerFetch(`${itemUrl(full(path))}?${SELECT}`, { headers: auth }, 'OneDrive stat');
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
        // The app folder itself is created by Graph on first access.
        const res = await providerFetch(APPROOT, { headers: auth }, 'OneDrive approot');
        if (!res.ok) {
          return failure(res, 'OneDrive approot');
        }
        await res.body?.cancel();
        return;
      }
      const create = (): Promise<Response> => providerFetch(`${itemUrl(parentOf(target))}/children`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ name: baseName(target), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      }, 'OneDrive mkdir');
      let res = await create();
      if (res.status === 404) {
        await res.body?.cancel();
        // Parent missing: create it relative to the pod root, then retry.
        await mkdirp(parentOf(path));
        res = await create();
      }
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
        const res = await providerFetch(`${itemUrl(full(path))}/content`, { headers: auth }, 'OneDrive read');
        if (!res.ok || !res.body) {
          return failure(res, 'OneDrive read');
        }
        return Readable.fromWeb(res.body as any);
      },

      list: async(path) => {
        const out: CloudStat[] = [];
        let next: string | undefined = `${itemUrl(full(path))}/children?${SELECT}&$top=1000`;
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
        const res = await providerFetch(`${itemUrl(full(path))}/content`, {
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
        await res.body?.cancel();
      },

      remove: async(path) => {
        const target = full(path);
        if (target === '/') {
          throw new Error('Refusing to delete the whole app folder.');
        }
        const res = await providerFetch(itemUrl(target), { method: 'DELETE', headers: auth }, 'OneDrive delete');
        if (!res.ok && res.status !== 404) {
          return failure(res, 'OneDrive delete');
        }
        await res.body?.cancel();
      },
    };
  }
}
