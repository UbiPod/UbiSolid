import { Readable } from 'node:stream';
import { NotFoundHttpError, PreconditionFailedHttpError } from '@solid/community-server';
import type { CloudAdapter, CloudFs, CloudStat } from '../CloudFs';
import { asBody, baseName, joinRoot, parentOf } from '../CloudFs';
import { failure, providerFetch } from './http';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,modifiedTime,version';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime: string;
  version?: string;
}

function toStat(f: DriveFile): CloudStat {
  return {
    name: f.name,
    isDirectory: f.mimeType === FOLDER,
    size: Number(f.size ?? 0),
    mtime: new Date(f.modifiedTime),
    version: f.version,
  };
}

const quote = (s: string): string => `'${s.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;

/**
 * Google Drive with the drive.file scope: the app sees only what it created, under one top-level folder
 * (default "UbiSolid"). Drive addresses files by ID, so paths are resolved segment by segment and cached;
 * a cached ID that 404s drops the cache. Drive has no conditional write, so `ifVersion` is check-then-write.
 * Not yet verified against a live Google client.
 */
export class GoogleDriveAdapter implements CloudAdapter {
  public readonly provider = 'googledrive';
  /** Full path (including the top folder) -> file ID. */
  private readonly ids = new Map<string, string>();

  public constructor(private readonly topFolder = 'UbiSolid') {}

  public open(accessToken: string, root: string): CloudFs {
    const auth = { authorization: `Bearer ${accessToken}` };
    const ids = this.ids;
    const top = `/${this.topFolder}`;
    const full = (path: string): string => joinRoot(`${top}${root}`, path);

    const find = async(parentId: string, name: string): Promise<DriveFile | undefined> => {
      const q = `name = ${quote(name)} and ${quote(parentId)} in parents and trashed = false`;
      const res = await providerFetch(
        `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`files(${FIELDS})`)}&spaces=drive`,
        { headers: auth }, 'Drive lookup',
      );
      if (!res.ok) {
        return failure(res, 'Drive lookup');
      }
      return (await res.json() as { files: DriveFile[] }).files[0];
    };

    const createFolder = async(parentId: string, name: string): Promise<string> => {
      const res = await providerFetch(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [ parentId ] }),
      }, 'Drive mkdir');
      if (!res.ok) {
        return failure(res, 'Drive mkdir');
      }
      return (await res.json() as { id: string }).id;
    };

    /** Resolve a full path to a file, optionally creating missing folders on the way. */
    const resolve = async(path: string, create = false): Promise<DriveFile | undefined> => {
      const segments = path.split('/').filter(Boolean);
      let parentId = 'root';
      let file: DriveFile | undefined;
      let current = '';
      for (const [ index, segment ] of segments.entries()) {
        current += `/${segment}`;
        const cached = ids.get(current);
        const last = index === segments.length - 1;
        if (cached && !last) {
          parentId = cached;
          continue;
        }
        file = await find(parentId, segment);
        if (!file && create) {
          const id = await createFolder(parentId, segment);
          file = { id, name: segment, mimeType: FOLDER, modifiedTime: new Date().toISOString() };
        }
        if (!file) {
          ids.delete(current);
          return undefined;
        }
        ids.set(current, file.id);
        parentId = file.id;
      }
      return file;
    };

    /** Like resolve, but retries once with an empty cache when a cached ID turns out stale. */
    const withRetry = async<T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (NotFoundHttpError.isInstance(error) && ids.size > 0) {
          ids.clear();
          return fn();
        }
        throw error;
      }
    };

    const stat = async(path: string): Promise<CloudStat | undefined> => {
      const file = await resolve(full(path));
      return file && toStat(file);
    };

    return {
      stat,

      read: (path) => withRetry(async() => {
        const file = await resolve(full(path));
        if (!file) {
          throw new NotFoundHttpError();
        }
        const res = await providerFetch(`${API}/files/${file.id}?alt=media`, { headers: auth }, 'Drive read');
        if (!res.ok || !res.body) {
          return failure(res, 'Drive read');
        }
        return Readable.fromWeb(res.body as any);
      }),

      list: (path) => withRetry(async() => {
        const dir = await resolve(full(path));
        if (!dir || dir.mimeType !== FOLDER) {
          throw new NotFoundHttpError();
        }
        const out: CloudStat[] = [];
        let pageToken: string | undefined;
        do {
          const q = `${quote(dir.id)} in parents and trashed = false`;
          const res: Response = await providerFetch(`${API}/files?q=${encodeURIComponent(q)}&pageSize=1000` +
            `&fields=${encodeURIComponent(`nextPageToken,files(${FIELDS})`)}${pageToken ? `&pageToken=${pageToken}` : ''}`,
          { headers: auth }, 'Drive list');
          if (!res.ok) {
            return failure(res, 'Drive list');
          }
          const page = await res.json() as { files: DriveFile[]; nextPageToken?: string };
          for (const f of page.files) {
            ids.set(`${full(path).replace(/\/$/u, '')}/${f.name}`, f.id);
            out.push(toStat(f));
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
        return out;
      }),

      write: (path, data, ifVersion) => withRetry(async() => {
        const target = full(path);
        const existing = await resolve(target);
        if (ifVersion && existing?.version !== ifVersion) {
          throw new PreconditionFailedHttpError('The file changed in Drive.');
        }
        let res: Response;
        if (existing) {
          res = await providerFetch(`${UPLOAD}/files/${existing.id}?uploadType=media&fields=${FIELDS}`, {
            method: 'PATCH',
            headers: { ...auth, 'content-type': 'application/octet-stream' },
            body: asBody(data),
          }, 'Drive write');
        } else {
          const parent = await resolve(parentOf(target), true);
          const boundary = `ubisolid${Date.now().toString(36)}`;
          const meta = JSON.stringify({ name: baseName(target), parents: [ parent!.id ] });
          const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
              `--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`),
            data,
            Buffer.from(`\r\n--${boundary}--`),
          ]);
          res = await providerFetch(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
            method: 'POST',
            headers: { ...auth, 'content-type': `multipart/related; boundary=${boundary}` },
            body: asBody(body),
          }, 'Drive write');
        }
        if (!res.ok) {
          return failure(res, 'Drive write');
        }
        const file = await res.json() as DriveFile;
        ids.set(target, file.id);
        return toStat(file);
      }),

      mkdirp: (path) => withRetry(async() => {
        await resolve(full(path), true);
      }),

      remove: (path) => withRetry(async() => {
        const target = full(path);
        if (target === top) {
          throw new Error('Refusing to delete the whole app folder.');
        }
        const file = await resolve(target);
        if (!file) {
          return;
        }
        // Deleting a folder the app owns deletes its contents too.
        const res = await providerFetch(`${API}/files/${file.id}`, { method: 'DELETE', headers: auth }, 'Drive delete');
        if (!res.ok && res.status !== 404) {
          return failure(res, 'Drive delete');
        }
        await res.body?.cancel();
        for (const key of [ ...ids.keys() ]) {
          if (key === target || key.startsWith(`${target}/`)) {
            ids.delete(key);
          }
        }
      }),
    };
  }
}
