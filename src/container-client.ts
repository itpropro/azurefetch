import { BlockBlobClient } from './block-blob-client'
import type { BlobDeleteIfExistsResponse } from './block-blob-client'
import { listNames } from './internal/blob-listing'
import type { ListOptions } from './internal/paging'
import { StorageTransport, storageRequestError } from './internal/storage-request'
import type { StorageClientOptions, StorageCredential } from './internal/storage-request'
import { appendUrlPath } from './internal/storage-url'

export interface BlobItem {
  name: string
}

export interface ListBlobsFlatSegment {
  segment: { blobItems: BlobItem[] }
  continuationToken: string
}

export interface ContainerCreateIfNotExistsResponse {
  succeeded: boolean
}

const containerQuery = { restype: 'container' }

export class ContainerClient {
  public readonly url: string
  private readonly credential: StorageCredential | undefined
  private readonly options: StorageClientOptions | undefined
  private readonly transport: StorageTransport

  public constructor(url: string, credential?: StorageCredential, options?: StorageClientOptions) {
    this.url = url
    this.credential = credential
    this.options = options
    this.transport = new StorageTransport(credential, options)
  }

  public getBlockBlobClient(blobName: string): BlockBlobClient {
    const segments = blobName.split('/')
    // URLs resolve dot segments, which would address a blob outside this container.
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      throw new TypeError(`Blob name must not contain "." or ".." path segments: ${blobName}`)
    }

    const path = segments.map((segment) => encodeURIComponent(segment)).join('/')
    return new BlockBlobClient(appendUrlPath(this.url, path), this.credential, this.options)
  }

  public async createIfNotExists(): Promise<ContainerCreateIfNotExistsResponse> {
    const response = await this.transport.send('PUT', this.url, { query: containerQuery })
    if (response.status === 409) {
      return { succeeded: false }
    }

    if (!response.ok) {
      throw storageRequestError('Container create', response)
    }

    return { succeeded: true }
  }

  public async deleteIfExists(): Promise<BlobDeleteIfExistsResponse> {
    const response = await this.transport.send('DELETE', this.url, { query: containerQuery })
    if (response.status === 404) {
      return { succeeded: false, errorCode: 'ContainerNotFound' }
    }

    if (!response.ok) {
      throw storageRequestError('Container delete', response)
    }

    return { succeeded: true }
  }

  public async exists(): Promise<boolean> {
    const response = await this.transport.send('HEAD', this.url, { query: containerQuery })
    if (response.status === 404) {
      return false
    }

    if (!response.ok) {
      throw storageRequestError('Container exists check', response)
    }

    return true
  }

  public listBlobsFlat(): {
    byPage: (options?: ListOptions) => AsyncIterable<ListBlobsFlatSegment>
  } {
    return { byPage: (options) => this.listBlobPages(options) }
  }

  private async *listBlobPages(options?: ListOptions): AsyncGenerator<ListBlobsFlatSegment> {
    const pages = listNames(this.transport, this.url, 'Blob', containerQuery, options)
    for await (const { names, continuationToken } of pages) {
      yield { segment: { blobItems: names.map((name) => ({ name })) }, continuationToken }
    }
  }
}
