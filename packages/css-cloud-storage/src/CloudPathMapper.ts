import * as mime from 'mime-types';
import type { ResourceIdentifier, ResourceLink } from '@solid/community-server';
import {
  BaseFileIdentifierMapper,
  ExtensionBasedMapper,
  joinFilePath,
  NotImplementedHttpError,
} from '@solid/community-server';
import type { CloudFs } from './CloudFs';

/**
 * CSS's ExtensionBasedMapper, but looking in the cloud folder instead of on local disk, so pods in the cloud
 * use exactly the file layout of a stock CSS file backend (`$.ext` suffixes, `.meta` files, `.acl` files).
 * A folder downloaded from the provider can be served by a plain CSS.
 *
 * "File paths" here are relative to the pod's folder in the provider and start with `/`.
 */
export class CloudPathMapper extends ExtensionBasedMapper {
  public constructor(podBase: string, private readonly fs: CloudFs) {
    super(podBase, '/');
  }

  protected async mapUrlToDocumentPath(identifier: ResourceIdentifier, filePath: string, contentType?: string):
  Promise<ResourceLink> {
    if (/\$\.\w+$/u.test(filePath)) {
      throw new NotImplementedHttpError('Identifiers cannot contain a dollar sign before their extension');
    }
    if (!contentType) {
      // Metadata files never get a $ suffix, and an exact match is the common case, so only list the
      // parent folder when the plain name isn't there.
      if (!filePath.endsWith('.meta') && !await this.fs.stat(filePath)) {
        const [ , folder, documentName ] = /^(.*\/)([^/]*)$/u.exec(filePath)!;
        try {
          const names = (await this.fs.list(folder)).map((entry) => entry.name);
          const fileName = names.find((name) => name.startsWith(documentName) &&
            /^(?:\$\..+)?$/u.test(name.slice(documentName.length)));
          if (fileName) {
            filePath = joinFilePath(folder, fileName);
          }
        } catch {
          // Parent folder does not exist.
        }
      }
      contentType = await this.getContentTypeFromPath(filePath);
    } else if (contentType !== await this.getContentTypeFromPath(filePath)) {
      // Same as ExtensionBasedMapper: store under a $.ext name matching the content type.
      let extension = mime.extension(contentType) || (this as any).customExtensions[contentType];
      if (!extension) {
        extension = this.unknownMediaTypeExtension;
        contentType = undefined;
      }
      filePath += `$.${extension}`;
    }
    return BaseFileIdentifierMapper.prototype['mapUrlToDocumentPath'].call(this, identifier, filePath, contentType);
  }
}
