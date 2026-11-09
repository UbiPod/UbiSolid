import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat as fsStat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NotFoundHttpError, PreconditionFailedHttpError } from '@solid/community-server';
import type { CloudAdapter, CloudFs, CloudStat } from '../CloudFs';
import { joinRoot, StorageUnavailableHttpError } from '../CloudFs';
import { TokenRejectedError } from './http';

/**
 * Stands in for a cloud provider in tests: the broker's fake provider issues `fake-at.<user>.<random>`
 * tokens and this adapter stores each user's "app folder" under `<directory>/<user>/`.
 * The directory defaults to FAKE_STORAGE_DIR; without one, the adapter refuses every token.
 */
export class LocalFolderAdapter implements CloudAdapter {
  public readonly provider = 'fake';

  private readonly directory?: string;

  public constructor(directory?: string) {
    this.directory = directory ?? process.env.FAKE_STORAGE_DIR;
  }

  public open(accessToken: string, root: string): CloudFs {
    if (!this.directory) {
      throw new StorageUnavailableHttpError('The fake provider is not enabled on this server.');
    }
    const match = /^fake-at\.([\w-]+)\./u.exec(accessToken);
    if (!match) {
      throw new TokenRejectedError('not a fake token');
    }
    const base = join(this.directory, match[1]);
    const real = (path: string): string => join(base, joinRoot(root, path));
    const toStat = async(path: string, name: string): Promise<CloudStat | undefined> => {
      try {
        const s = await fsStat(path);
        return { name, isDirectory: s.isDirectory(), size: s.size, mtime: s.mtime, version: String(s.mtimeMs) };
      } catch {
        return undefined;
      }
    };
    return {
      stat: (path) => toStat(real(path), path.split('/').pop() ?? ''),
      read: async(path) => createReadStream(real(path)),
      list: async(path) => {
        let names: string[];
        try {
          names = await readdir(real(path));
        } catch {
          throw new NotFoundHttpError();
        }
        const stats = await Promise.all(names.map((n) => toStat(join(real(path), n), n)));
        return stats.filter((s): s is CloudStat => Boolean(s));
      },
      write: async(path, data, ifVersion) => {
        if (ifVersion && (await toStat(real(path), ''))?.version !== ifVersion) {
          throw new PreconditionFailedHttpError();
        }
        await mkdir(dirname(real(path)), { recursive: true });
        await writeFile(real(path), data);
        return toStat(real(path), path.split('/').pop() ?? '');
      },
      mkdirp: async(path) => {
        await mkdir(real(path), { recursive: true });
      },
      remove: async(path) => {
        await rm(real(path), { recursive: true, force: true });
      },
    };
  }
}
