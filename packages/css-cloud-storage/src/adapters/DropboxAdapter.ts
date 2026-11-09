import { Readable } from 'node:stream';
import { NotFoundHttpError, PreconditionFailedHttpError } from '@solid/community-server';
import type { CloudAdapter, CloudFs, CloudStat } from '../CloudFs';
import { asBody, joinRoot } from '../CloudFs';
import { failure, providerFetch } from './http';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

interface Metadata {
  '.tag': 'file' | 'folder' | 'deleted';
  name: string;
  size?: number;
  server_modified?: string;
  rev?: string;
}

/** Dropbox-API-Arg must be ASCII; escape everything else as \uXXXX. */
function apiArg(arg: object): string {
  return JSON.stringify(arg).replace(/[\u007F-￿]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** In an App folder app, "" is the app folder itself and every other path starts with /. */
function dbxPath(path: string): string {
  return path === '/' ? '' : path;
}

function toStat(m: Metadata): CloudStat {
  return {
    name: m.name,
    isDirectory: m['.tag'] === 'folder',
    size: m.size ?? 0,
    // Folders carry no timestamp in Dropbox.
    mtime: m.server_modified ? new Date(m.server_modified) : new Date(0),
    version: m.rev,
  };
}

/** Dropbox errors arrive as 409 with an error_summary such as "path/not_found/..". */
async function dropboxError(res: Response, label: string): Promise<{ summary: string; res: Response }> {
  const text = await res.text();
  let summary = '';
  try {
    summary = (JSON.parse(text) as { error_summary?: string }).error_summary ?? '';
  } catch {
    summary = text;
  }
  return { summary, res: new Response(`${label}: ${summary}`, { status: res.status }) };
}

/**
 * Dropbox, App folder permission. Writes use WriteMode.update with strict_conflict when a version is given.
 * Not yet verified against a live Dropbox app.
 */
export class DropboxAdapter implements CloudAdapter {
  public readonly provider = 'dropbox';

  public open(accessToken: string, root: string): CloudFs {
    const auth = { authorization: `Bearer ${accessToken}` };
    const full = (path: string): string => dbxPath(joinRoot(root, path));
    const rpc = (endpoint: string, body: object, label: string): Promise<Response> =>
      providerFetch(`${API}/${endpoint}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, label);

    return {
      stat: async(path) => {
        const target = full(path);
        if (target === '') {
          return { name: '', isDirectory: true, size: 0, mtime: new Date(0) };
        }
        const res = await rpc('files/get_metadata', { path: target }, 'Dropbox stat');
        if (res.status === 409) {
          const { summary, res: r } = await dropboxError(res, 'Dropbox stat');
          return summary.includes('not_found') ? undefined : failure(r, 'Dropbox stat');
        }
        if (!res.ok) {
          return failure(res, 'Dropbox stat');
        }
        return toStat(await res.json() as Metadata);
      },

      read: async(path) => {
        const res = await providerFetch(`${CONTENT}/files/download`, {
          method: 'POST',
          headers: { ...auth, 'dropbox-api-arg': apiArg({ path: full(path) }) },
        }, 'Dropbox read');
        if (res.status === 409) {
          const { summary, res: r } = await dropboxError(res, 'Dropbox read');
          return summary.includes('not_found') ? Promise.reject(new NotFoundHttpError()) : failure(r, 'Dropbox read');
        }
        if (!res.ok || !res.body) {
          return failure(res, 'Dropbox read');
        }
        return Readable.fromWeb(res.body as any);
      },

      list: async(path) => {
        const out: CloudStat[] = [];
        let res = await rpc('files/list_folder', { path: full(path), limit: 2000 }, 'Dropbox list');
        for (;;) {
          if (res.status === 409) {
            const { summary, res: r } = await dropboxError(res, 'Dropbox list');
            if (summary.includes('not_found')) {
              throw new NotFoundHttpError();
            }
            return failure(r, 'Dropbox list');
          }
          if (!res.ok) {
            return failure(res, 'Dropbox list');
          }
          const page = await res.json() as { entries: Metadata[]; cursor: string; has_more: boolean };
          out.push(...page.entries.filter((e) => e['.tag'] !== 'deleted').map(toStat));
          if (!page.has_more) {
            return out;
          }
          res = await rpc('files/list_folder/continue', { cursor: page.cursor }, 'Dropbox list');
        }
      },

      write: async(path, data, ifVersion) => {
        // Single-request upload, up to 150 MiB. Parent folders are created automatically.
        const mode = ifVersion ? { '.tag': 'update', update: ifVersion } : { '.tag': 'overwrite' };
        const res = await providerFetch(`${CONTENT}/files/upload`, {
          method: 'POST',
          headers: {
            ...auth,
            'content-type': 'application/octet-stream',
            'dropbox-api-arg': apiArg({ path: full(path), mode, strict_conflict: true, mute: true }),
          },
          body: asBody(data),
        }, 'Dropbox write');
        if (res.status === 409) {
          const { summary, res: r } = await dropboxError(res, 'Dropbox write');
          if (ifVersion && summary.includes('conflict')) {
            throw new PreconditionFailedHttpError('The file changed in Dropbox.');
          }
          return failure(r, 'Dropbox write');
        }
        if (!res.ok) {
          return failure(res, 'Dropbox write');
        }
        return toStat(await res.json() as Metadata);
      },

      mkdirp: async(path) => {
        const target = full(path);
        if (target === '') {
          return;
        }
        // create_folder_v2 creates missing parents.
        const res = await rpc('files/create_folder_v2', { path: target, autorename: false }, 'Dropbox mkdir');
        if (res.status === 409) {
          const { summary, res: r } = await dropboxError(res, 'Dropbox mkdir');
          if (summary.includes('conflict/folder')) {
            return;
          }
          return failure(r, 'Dropbox mkdir');
        }
        if (!res.ok) {
          return failure(res, 'Dropbox mkdir');
        }
        await res.body?.cancel();
      },

      remove: async(path) => {
        const target = full(path);
        if (target === '') {
          throw new Error('Refusing to delete the whole app folder.');
        }
        const res = await rpc('files/delete_v2', { path: target }, 'Dropbox delete');
        if (res.status === 409) {
          const { summary, res: r } = await dropboxError(res, 'Dropbox delete');
          return summary.includes('not_found') ? undefined : failure(r, 'Dropbox delete');
        }
        if (!res.ok) {
          return failure(res, 'Dropbox delete');
        }
        await res.body?.cancel();
      },
    };
  }
}
