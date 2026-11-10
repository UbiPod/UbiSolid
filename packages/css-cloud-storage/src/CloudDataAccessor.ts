import type { Readable } from 'node:stream';
import type {
  DataAccessor,
  Guarded,
  Representation,
  RepresentationMetadata as Metadata,
  ResourceIdentifier,
  ResourceLink,
} from '@solid/community-server';
import {
  addResourceMetadata,
  CONTENT_TYPE_TERM,
  DC,
  getLoggerFor,
  guardStream,
  IANA,
  isContainerIdentifier,
  isContainerPath,
  LDP,
  NotFoundHttpError,
  parseContentType,
  parseQuads,
  POSIX,
  RDF,
  RepresentationMetadata,
  serializeQuads,
  SOLID_META,
  toLiteral,
  toNamedTerm,
  UnsupportedMediaTypeHttpError,
  updateModifiedDate,
  XSD,
} from '@solid/community-server';
import type { CloudAdapter, CloudFs, CloudStat } from './CloudFs';
import { PayloadTooLargeHttpError, StorageUnavailableHttpError } from './CloudFs';
import { TokenRejectedError } from './adapters/http';
import { PodListingCache } from './CachedCloudFs';
import { CloudPathMapper } from './CloudPathMapper';
import type { PodLinkIndex } from './PodLinkIndex';
import type { TokenBrokerClient } from './TokenBrokerClient';

interface Target {
  fs: CloudFs;
  mapper: CloudPathMapper;
  retry: () => Promise<Target>;
}

function toBuffer(stream: Readable, max: number): Promise<Buffer> {
  // Plain events rather than `for await`: async iteration doesn't get along with CSS's guarded streams.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > max) {
        stream.destroy();
        reject(new PayloadTooLargeHttpError(`Files in cloud-backed pods are limited to ${Math.floor(max / 1048576)} MB for now.`));
        return;
      }
      chunks.push(buffer);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * A DataAccessor that keeps each linked pod in its owner's cloud storage (OneDrive, Dropbox, Google Drive)
 * and everything else (the server root, /.internal/, unlinked pods) in the fallback accessor on local disk.
 *
 * It mirrors CSS 7.3's FileDataAccessor operation for operation, with the cloud folder in place of the
 * file system, so the stored layout is the same.
 *
 * It holds nothing but short-lived access tokens, fetched from the token broker per pod.
 */
export class CloudDataAccessor implements DataAccessor {
  protected readonly logger = getLoggerFor(this);
  private readonly adapters: Map<string, CloudAdapter>;
  /** Per-pod folder listings: see PodListingCache. */
  private readonly caches = new Map<string, PodListingCache>();

  /**
   * @param fallback - Accessor for everything not in a linked pod (normally the FileDataAccessor).
   * @param broker - Token broker client.
   * @param pods - Which pods are linked to which storage.
   * @param adapters - One adapter per provider.
   * @param maxUploadMb - Largest document accepted, as uploads are buffered in memory.
   */
  public constructor(
    private readonly fallback: DataAccessor,
    private readonly broker: TokenBrokerClient,
    private readonly pods: PodLinkIndex,
    adapters: CloudAdapter[],
    private readonly maxUploadMb = 100,
  ) {
    this.adapters = new Map(adapters.map((a) => [ a.provider, a ]));
  }

  /** Where the resource lives: undefined means the fallback. */
  private async target(identifier: ResourceIdentifier, fresh = false): Promise<Target | undefined> {
    const link = await this.pods.match(identifier.path);
    if (!link) {
      return undefined;
    }
    if (fresh) {
      this.broker.invalidate(link.linkId, link.podBase);
    }
    const token = await this.broker.token(link.linkId, link.podBase);
    const adapter = this.adapters.get(token.provider);
    if (!adapter) {
      throw new StorageUnavailableHttpError(`No adapter for ${token.provider} on this server.`);
    }
    const key = `${link.linkId} ${token.provider} ${token.root} ${JSON.stringify(token.location ?? {})}`;
    let cache = this.caches.get(key);
    if (!cache) {
      cache = new PodListingCache();
      this.caches.set(key, cache);
    }
    const fs = cache.wrap(adapter.open(token.accessToken, token.root, token.location));
    return {
      fs,
      mapper: new CloudPathMapper(link.podBase, fs),
      retry: async() => (await this.target(identifier, true))!,
    };
  }

  /** Runs `fn` against the cloud, retrying once with a fresh token if the provider rejected the cached one. */
  private async cloud<T>(t: Target, fn: (t: Target) => Promise<T>): Promise<T> {
    try {
      return await fn(t);
    } catch (error) {
      if (error instanceof TokenRejectedError) {
        try {
          return await fn(await t.retry());
        } catch (retryError) {
          if (retryError instanceof TokenRejectedError) {
            throw new StorageUnavailableHttpError('The storage provider rejected a fresh access token.');
          }
          throw retryError;
        }
      }
      throw error;
    }
  }

  public async canHandle(representation: Representation): Promise<void> {
    if (!representation.binary) {
      throw new UnsupportedMediaTypeHttpError('Only binary data is supported.');
    }
  }

  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    const t = await this.target(identifier);
    if (!t) {
      return this.fallback.getData(identifier);
    }
    return this.cloud(t, async({ fs, mapper }) => {
      const link = await mapper.mapUrlToFilePath(identifier, false);
      const stat = await fs.stat(link.filePath);
      if (!stat || stat.isDirectory) {
        throw new NotFoundHttpError();
      }
      return guardStream(await fs.read(link.filePath));
    });
  }

  public async getMetadata(identifier: ResourceIdentifier): Promise<Metadata> {
    const t = await this.target(identifier);
    if (!t) {
      return this.fallback.getMetadata(identifier);
    }
    return this.cloud(t, async({ fs, mapper }) => {
      const link = await mapper.mapUrlToFilePath(identifier, false);
      const stat = await fs.stat(link.filePath);
      const isContainer = isContainerIdentifier(identifier);
      if (!stat || stat.isDirectory !== isContainer) {
        throw new NotFoundHttpError();
      }
      const metadata = await this.getRawMetadata(fs, mapper, identifier);
      addResourceMetadata(metadata, isContainer);
      this.addPosixMetadata(metadata, stat);
      // As in FileDataAccessor: a content type stored in .meta (unsupported types) wins over the extension.
      if (!isContainer && typeof metadata.contentType === 'undefined') {
        metadata.set(CONTENT_TYPE_TERM, link.contentType);
      }
      return metadata;
    });
  }

  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<Metadata> {
    const t = await this.target(identifier);
    if (!t) {
      yield* this.fallback.getChildren(identifier);
      return;
    }
    const children = await this.cloud(t, async({ fs, mapper }) => {
      const link = await mapper.mapUrlToFilePath(identifier, false);
      const entries = await fs.list(link.filePath);
      const out: Metadata[] = [];
      for (const entry of entries) {
        const childPath = `${link.filePath.replace(/\/$/u, '')}/${entry.name}`;
        const childLink = await mapper.mapFilePathToUrl(childPath, entry.isDirectory);
        if (childLink.isMetadata) {
          continue;
        }
        const metadata = new RepresentationMetadata(childLink.identifier);
        addResourceMetadata(metadata, entry.isDirectory);
        this.addPosixMetadata(metadata, entry);
        if (childLink.contentType) {
          try {
            const { value } = parseContentType(childLink.contentType);
            metadata.add(RDF.terms.type, toNamedTerm(`${IANA.namespace}${value}#Resource`));
          } catch {
            this.logger.warn(`Invalid content-type "${childLink.contentType}" for ${childLink.identifier.path}`);
          }
        }
        out.push(metadata);
      }
      return out;
    });
    yield* children;
  }

  public async writeDocument(identifier: ResourceIdentifier, data: Guarded<Readable>, metadata: Metadata):
  Promise<void> {
    const t = await this.target(identifier);
    if (!t) {
      return this.fallback.writeDocument(identifier, data, metadata);
    }
    // Read the body once, up front, so a retry with a fresh token can resend it.
    const body = await toBuffer(data, this.maxUploadMb * 1048576);
    return this.cloud(t, async({ fs, mapper }) => {
      const link = await mapper.mapUrlToFilePath(identifier, false, metadata.contentType);
      // Remove a stored copy under a different extension (content type changed).
      const oldLink = await mapper.mapUrlToFilePath(identifier, false);
      if (oldLink.filePath !== link.filePath) {
        await fs.remove(oldLink.filePath);
      }
      const wroteMetadata = await this.writeMetadataFile(fs, mapper, link, metadata);
      try {
        await fs.write(link.filePath, body);
      } catch (error) {
        if (wroteMetadata) {
          await fs.remove((await mapper.mapUrlToFilePath(identifier, true)).filePath);
        }
        throw error;
      }
    });
  }

  public async writeContainer(identifier: ResourceIdentifier, metadata: Metadata): Promise<void> {
    const t = await this.target(identifier);
    if (!t) {
      return this.fallback.writeContainer(identifier, metadata);
    }
    return this.cloud(t, async({ fs, mapper }) => {
      const link = await mapper.mapUrlToFilePath(identifier, false);
      await fs.mkdirp(link.filePath);
      await this.writeMetadataFile(fs, mapper, link, metadata);
    });
  }

  public async writeMetadata(identifier: ResourceIdentifier, metadata: Metadata): Promise<void> {
    const t = await this.target(identifier);
    if (!t) {
      return this.fallback.writeMetadata(identifier, metadata);
    }
    return this.cloud(t, async({ fs, mapper }) => {
      const metadataLink = await mapper.mapUrlToFilePath(identifier, true);
      await this.writeMetadataFile(fs, mapper, metadataLink, metadata);
    });
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const t = await this.target(identifier);
    if (!t) {
      return this.fallback.deleteResource(identifier);
    }
    return this.cloud(t, async({ fs, mapper }) => {
      await fs.remove((await mapper.mapUrlToFilePath(identifier, true)).filePath);
      const link = await mapper.mapUrlToFilePath(identifier, false);
      const stat = await fs.stat(link.filePath);
      if (!stat || stat.isDirectory !== isContainerIdentifier(identifier)) {
        throw new NotFoundHttpError();
      }
      await fs.remove(link.filePath);
    });
  }

  // ------------------------------------------------------------ helpers, as in FileDataAccessor

  private async getRawMetadata(fs: CloudFs, mapper: CloudPathMapper, identifier: ResourceIdentifier):
  Promise<Metadata> {
    const metadataLink = await mapper.mapUrlToFilePath(identifier, true);
    const stat = await fs.stat(metadataLink.filePath);
    if (!stat) {
      return new RepresentationMetadata(identifier);
    }
    const quads = await parseQuads(guardStream(await fs.read(metadataLink.filePath)),
      { format: metadataLink.contentType, baseIRI: identifier.path });
    const metadata = new RepresentationMetadata(identifier).addQuads(quads);
    updateModifiedDate(metadata, stat.mtime);
    return metadata;
  }

  private async writeMetadataFile(fs: CloudFs, mapper: CloudPathMapper, link: ResourceLink, metadata: Metadata):
  Promise<boolean> {
    // These are stored by file system conventions.
    metadata.remove(RDF.terms.type, LDP.terms.Resource);
    metadata.remove(RDF.terms.type, LDP.terms.Container);
    metadata.remove(RDF.terms.type, LDP.terms.BasicContainer);
    metadata.removeAll(DC.terms.modified);
    if (isContainerPath(link.filePath) || typeof link.contentType !== 'undefined') {
      metadata.removeAll(CONTENT_TYPE_TERM);
    }
    const quads = metadata.quads();
    const metadataLink = await mapper.mapUrlToFilePath(link.identifier, true);
    if (quads.length > 0) {
      const serialized = await toBuffer(serializeQuads(quads, metadataLink.contentType), Number.POSITIVE_INFINITY);
      await fs.write(metadataLink.filePath, serialized);
      return true;
    }
    await fs.remove(metadataLink.filePath);
    return false;
  }

  private addPosixMetadata(metadata: Metadata, stat: CloudStat): void {
    const modified = new Date(metadata.get(DC.terms.modified)?.value ?? 0);
    if (modified < stat.mtime) {
      updateModifiedDate(metadata, stat.mtime);
    }
    metadata.add(POSIX.terms.mtime, toLiteral(Math.floor(stat.mtime.getTime() / 1000), XSD.terms.integer),
      SOLID_META.terms.ResponseMetadata);
    if (!stat.isDirectory) {
      metadata.add(POSIX.terms.size, toLiteral(stat.size, XSD.terms.integer), SOLID_META.terms.ResponseMetadata);
    }
  }
}
