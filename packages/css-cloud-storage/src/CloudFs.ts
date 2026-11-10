import type { Readable } from 'node:stream';
import { HttpError } from '@solid/community-server';

/** One file or folder in the provider. */
export interface CloudStat {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: Date;
  /** Provider version tag: OneDrive eTag, Dropbox rev, Drive version. */
  version?: string;
}

/**
 * The few file operations CloudDataAccessor needs, relative to one pod's folder in the provider.
 * Paths always start with `/`; `/` is the pod's folder itself.
 */
export interface CloudFs {
  stat: (path: string) => Promise<CloudStat | undefined>;
  read: (path: string) => Promise<Readable>;
  /** Throws NotFoundHttpError if the folder does not exist. */
  list: (path: string) => Promise<CloudStat[]>;
  /**
   * Creates missing parent folders. With `ifVersion`, fails with 412 unless the current version matches.
   * Returns the new file's stat when the provider reports it, which saves a listing.
   */
  write: (path: string, data: Buffer, ifVersion?: string) => Promise<CloudStat | void>;
  mkdirp: (path: string) => Promise<void>;
  /** Recursive. No error if it doesn't exist. */
  remove: (path: string) => Promise<void>;
}

/** Turns an access token and a pod folder into a CloudFs for one provider. */
export interface CloudAdapter {
  /** Matches the broker's provider name: onedrive, dropbox, googledrive or fake. */
  readonly provider: string;
  /** `location` is provider-specific placement from the broker, e.g. the drive and folder in tenant mode. */
  open: (accessToken: string, root: string, location?: Record<string, string>) => CloudFs;
}

/** 503: the pod's storage is unreachable or disconnected. */
export class StorageUnavailableHttpError extends HttpError<503> {
  public constructor(message?: string, options?: { cause?: unknown }) {
    super(503, 'StorageUnavailableHttpError', message ?? 'The storage behind this pod is unavailable.', options);
  }
}

/** 413: bigger than this plugin will buffer. */
export class PayloadTooLargeHttpError extends HttpError<413> {
  public constructor(message?: string) {
    super(413, 'PayloadTooLargeHttpError', message);
  }
}

/** Buffers as fetch bodies, without copying. */
export function asBody(data: Buffer): BodyInit {
  return data as unknown as BodyInit;
}

/** 507: the provider says the owner's storage is full. */
export class InsufficientStorageHttpError extends HttpError<507> {
  public constructor(message?: string, options?: { cause?: unknown }) {
    super(507, 'InsufficientStorageHttpError', message ?? 'The storage behind this pod is full.', options);
  }
}

/** Joins a pod root such as `/alice` with a pod-relative path such as `/profile/card`. */
export function joinRoot(root: string, path: string): string {
  const joined = `${root.replace(/\/+$/u, '')}/${path.replace(/^\/+/u, '')}`;
  return joined.length > 1 ? joined.replace(/\/+$/u, '') : '/';
}

export function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/u, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

export function baseName(path: string): string {
  return path.replace(/\/+$/u, '').split('/').pop() ?? '';
}
