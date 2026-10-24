import { StorageTransport, storageRequestError } from './internal/storage-request'
import type { StorageClientOptions, StorageCredential } from './internal/storage-request'

export interface BlobGetPropertiesResponse {
  etag?: string
  lastModified?: Date
  lastAccessed?: Date
  createdOn?: Date
  metadata: Record<string, string>
}

export interface BlobDeleteIfExistsResponse {
  succeeded: boolean
  errorCode?: string
}

export interface BlobUploadOptions {
  /** Defaults to `application/octet-stream`. */
  contentType?: string
}

export interface BlobDeleteOptions {
  deleteSnapshots?: 'include' | 'only'
}

const metadataPrefix = 'x-ms-meta-'

export class BlockBlobClient {
  public readonly url: string
  private readonly transport: StorageTransport

  public constructor(url: string, credential?: StorageCredential, options?: StorageClientOptions) {
    this.url = url
    this.transport = new StorageTransport(credential, options)
  }

  public async upload(
    body: string | BufferSource | Blob,
    options: BlobUploadOptions = {},
  ): Promise<Response> {
    const response = await this.transport.send('PUT', this.url, {
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': options.contentType ?? 'application/octet-stream',
      },
      body,
    })
    if (!response.ok) {
      throw storageRequestError('Blob upload', response)
    }

    return response
  }

  public async download(offset = 0, count?: number): Promise<Response> {
    const end = count === undefined ? '' : String(offset + count - 1)
    const response = await this.transport.send('GET', this.url, {
      headers: offset > 0 || count !== undefined ? { Range: `bytes=${offset}-${end}` } : {},
    })
    if (!response.ok) {
      throw storageRequestError('Blob download', response)
    }

    return response
  }

  public async deleteIfExists(
    options: BlobDeleteOptions = {},
  ): Promise<BlobDeleteIfExistsResponse> {
    const response = await this.transport.send('DELETE', this.url, {
      headers:
        options.deleteSnapshots === undefined
          ? {}
          : { 'x-ms-delete-snapshots': options.deleteSnapshots },
    })
    if (response.status === 404) {
      return { succeeded: false, errorCode: 'BlobNotFound' }
    }

    if (!response.ok) {
      throw storageRequestError('Blob delete', response)
    }

    return { succeeded: true }
  }

  public async getProperties(): Promise<BlobGetPropertiesResponse> {
    const response = await this.transport.send('HEAD', this.url)
    if (!response.ok) {
      throw storageRequestError('Blob getProperties', response)
    }

    const { headers } = response
    return {
      etag: headers.get('etag') ?? undefined,
      lastModified: parseDate(headers.get('last-modified')),
      lastAccessed: parseDate(headers.get('x-ms-last-access-time')),
      createdOn: parseDate(headers.get('x-ms-creation-time')),
      metadata: Object.fromEntries(
        Array.from(headers)
          .filter(([name]) => name.startsWith(metadataPrefix))
          .map(([name, value]) => [name.slice(metadataPrefix.length), value]),
      ),
    }
  }
}

function parseDate(value: string | null): Date | undefined {
  return value === null ? undefined : new Date(value)
}
