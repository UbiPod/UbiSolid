import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { NotFoundHttpError } from '@solid/community-server';
import type { CloudFs, CloudStat } from './CloudFs';
import { baseName, parentOf } from './CloudFs';

type Listing = Map<string, CloudStat> | undefined;

/** Files up to this size are kept in memory by version: ACLs, .meta files, profiles. */
const SMALL_FILE = 64 * 1024;
const MAX_FILES = 1_000;

function fromBuffer(data: Buffer): Readable {
  const stream = new PassThrough();
  stream.end(data);
  return stream;
}

/** Plain stream events; async iteration over CSS's guarded streams crashes the process. */
function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Folder listings for one pod, kept for a few seconds.
 *
 * CSS asks about a resource and its siblings over and over in one request: the document, its
 * `$.ext` variant, `.meta`, `.acl`, `.acl.meta`. Each is a stat, and each stat is a round trip
 * of up to a second. Answering them all from one listing of the folder turns a 17-call read into 3.
 *
 * Small files are also kept, keyed by the version the listing reports, so a warm read of an ACL
 * or `.meta` file costs nothing.
 *
 * Changes made through this server invalidate the affected folders at once. Changes made directly
 * in the provider show up after at most `ttlMs`.
 */
export class PodListingCache {
  private readonly listings = new Map<string, { at: number; value: Promise<Listing> }>();
  private readonly files = new Map<string, { version: string; data: Buffer }>();
  private rootStat?: { at: number; value: Promise<CloudStat | undefined> };
  /** Bumped by every invalidation, so a listing that started before it isn't kept. */
  private generation = 0;

  public constructor(private readonly ttlMs = 15_000, private readonly maxFolders = 2_000) {}

  public wrap(fs: CloudFs): CloudFs {
    const listing = (path: string): Promise<Listing> => this.listing(fs, path);
    const stat = async(path: string): Promise<CloudStat | undefined> => {
      if (path === '/') {
        return this.statRoot(fs);
      }
      return (await listing(parentOf(path)))?.get(baseName(path));
    };
    return {
      stat,
      list: async(path) => {
        const entries = await listing(path);
        if (!entries) {
          throw new NotFoundHttpError();
        }
        return [ ...entries.values() ];
      },
      read: async(path) => {
        const info = await stat(path);
        if (!info?.version || info.isDirectory || info.size > SMALL_FILE) {
          return fs.read(path);
        }
        const hit = this.files.get(path);
        if (hit?.version === info.version) {
          return fromBuffer(hit.data);
        }
        const data = await collect(await fs.read(path));
        this.files.delete(path);
        this.files.set(path, { version: info.version, data });
        if (this.files.size > MAX_FILES) {
          this.files.delete(this.files.keys().next().value!);
        }
        return fromBuffer(data);
      },
      write: async(path, data, ifVersion) => {
        let result: CloudStat | void;
        try {
          result = await fs.write(path, data, ifVersion);
        } catch (error: unknown) {
          this.invalidate(path);
          throw error;
        }
        if (!(result && await this.updateEntry(path, result))) {
          this.invalidate(path);
        }
        return result;
      },
      mkdirp: async(path) => {
        // CSS writes every container on the way down; most of them already exist.
        if ((await stat(path).catch(() => undefined))?.isDirectory) {
          return;
        }
        try {
          await fs.mkdirp(path);
        } finally {
          this.invalidate(path);
        }
      },
      remove: async(path) => {
        // CSS removes every alternative a document might be stored under (.meta, other extensions).
        if (path !== '/' && !await stat(path).catch(() => true)) {
          return;
        }
        try {
          await fs.remove(path);
        } finally {
          this.invalidate(path, true);
        }
      },
    };
  }

  /**
   * Puts a freshly written file into its folder's cached listing, so the next stat needs no call.
   * Returns false when there is no usable listing to update. A cached listing means the folder
   * existed before the write, so no other folder changed.
   * The folder's own stat (its mtime and version) is left as it was until the listing expires.
   */
  private async updateEntry(filePath: string, file: CloudStat): Promise<boolean> {
    const path = parentOf(filePath).replace(/\/+$/u, '') || '/';
    const entry = this.listings.get(path);
    if (!entry || Date.now() - entry.at >= this.ttlMs) {
      return false;
    }
    const listing = await entry.value.catch(() => undefined);
    if (!listing || this.listings.get(path) !== entry) {
      return false;
    }
    const name = baseName(filePath);
    listing.set(name, { ...file, name });
    this.files.delete(filePath);
    return true;
  }

  /** Drops the folders that a change at `path` can affect: its ancestors, and with `subtree` everything below it. */
  public invalidate(changed: string, subtree = false): void {
    const path = changed.replace(/\/+$/u, '') || '/';
    this.generation++;
    this.rootStat = undefined;
    const prefix = `${path.replace(/\/+$/u, '')}/`;
    for (const key of this.files.keys()) {
      if (key === path || key.startsWith(prefix)) {
        this.files.delete(key);
      }
    }
    for (const key of this.listings.keys()) {
      const isAncestor = key === '/' || prefix.startsWith(`${key}/`) || key === path;
      if (isAncestor || (subtree && key.startsWith(prefix))) {
        this.listings.delete(key);
      }
    }
  }

  private listing(fs: CloudFs, folder: string): Promise<Listing> {
    // '/a/' and '/a' are the same folder.
    const path = folder.replace(/\/+$/u, '') || '/';
    const now = Date.now();
    const hit = this.listings.get(path);
    if (hit && now - hit.at < this.ttlMs) {
      return hit.value;
    }
    const generation = this.generation;
    const value = fs.list(path).then(
      (children) => new Map(children.map((child) => [ child.name, child ])),
      (error: unknown) => {
        if (NotFoundHttpError.isInstance(error)) {
          return undefined;
        }
        throw error;
      },
    );
    this.listings.set(path, { at: now, value });
    // Errors and listings overtaken by a change are not kept.
    value.then(() => {
      if (generation !== this.generation && this.listings.get(path)?.value === value) {
        this.listings.delete(path);
      }
    }, () => {
      if (this.listings.get(path)?.value === value) {
        this.listings.delete(path);
      }
    });
    this.sweep(now);
    return value;
  }

  private statRoot(fs: CloudFs): Promise<CloudStat | undefined> {
    const now = Date.now();
    if (this.rootStat && now - this.rootStat.at < this.ttlMs) {
      return this.rootStat.value;
    }
    const value = fs.stat('/');
    const entry = { at: now, value };
    this.rootStat = entry;
    value.catch(() => {
      if (this.rootStat === entry) {
        this.rootStat = undefined;
      }
    });
    return value;
  }

  private sweep(now: number): void {
    if (this.listings.size <= this.maxFolders) {
      return;
    }
    for (const [ key, entry ] of this.listings) {
      if (now - entry.at >= this.ttlMs || this.listings.size > this.maxFolders) {
        this.listings.delete(key);
      }
    }
  }
}
