import { BlobBatchClient } from './blob-batch-client'
import { ContainerClient } from './container-client'
import { listNames } from './internal/blob-listing'
import type { ListOptions } from './internal/paging'
import {
  StorageTransport,
  parseStorageConnectionString,
  storageAccountName,
  storageServiceVersion,
} from './internal/storage-request'
import type { StorageClientOptions, StorageCredential } from './internal/storage-request'
import { appendUrlPath, normalizeStorageUrl } from './internal/storage-url'
import { StorageSharedKeyCredential } from './storage-shared-key-credential'

export interface ContainerItem {
  name: string
}

export interface ListContainersSegment {
  segment: { containerItems: ContainerItem[] }
  continuationToken: string
}

export interface AccountSasOptions {
  /** Any of `rwdxftlacupiy`. */
  permissions?: string
  /** Any of `btqf`, defaults to `b`. */
  services?: string
  /** Any of `sco`, defaults to `sco`. */
  resourceTypes?: string
  protocol?: 'https' | 'https,http'
}

const fractionalSeconds = /\.\d{3}Z$/u

export class BlobServiceClient {
  public readonly accountName: string
  public readonly url: string
  private readonly credential: StorageCredential | undefined
  private readonly options: StorageClientOptions | undefined
  private readonly transport: StorageTransport

  public constructor(url: string, credential?: StorageCredential, options?: StorageClientOptions) {
    this.url = normalizeStorageUrl(url)
    this.accountName = storageAccountName(url, credential)

    this.credential = credential
    this.options = options
    this.transport = new StorageTransport(credential, options)
  }

  public static fromConnectionString(
    connectionString: string,
    options?: StorageClientOptions,
  ): BlobServiceClient {
    const { url, credential } = parseStorageConnectionString(connectionString, 'blob')
    return new BlobServiceClient(url, credential, options)
  }

  public getContainerClient(containerName: string): ContainerClient {
    const url = appendUrlPath(this.url, encodeURIComponent(containerName))
    return new ContainerClient(url, this.credential, this.options)
  }

  public getBlobBatchClient(): BlobBatchClient {
    return new BlobBatchClient(this.url, this.credential, this.options)
  }

  public listContainers(): {
    byPage: (options?: ListOptions) => AsyncIterable<ListContainersSegment>
  } {
    return { byPage: (options) => this.listContainerPages(options) }
  }

  public async generateAccountSasUrl(
    expiresOn = new Date(Date.now() + 60 * 60 * 1000),
    options: AccountSasOptions = {},
  ): Promise<string> {
    if (!(this.credential instanceof StorageSharedKeyCredential)) {
      throw new TypeError('Account SAS generation requires a StorageSharedKeyCredential')
    }

    if (Number.isNaN(expiresOn.getTime())) {
      throw new RangeError('Account SAS expiry must be a valid date')
    }

    const parameters = {
      sp: canonicalSasCharacters(options.permissions ?? '', 'rwdxftlacupiy', 'permissions'),
      ss: canonicalSasCharacters(options.services ?? 'b', 'btqf', 'services'),
      srt: canonicalSasCharacters(options.resourceTypes ?? 'sco', 'sco', 'resource types'),
      sv: storageServiceVersion,
      se: expiresOn.toISOString().replace(fractionalSeconds, 'Z'),
      spr: options.protocol ?? 'https',
    }
    const { sp, ss, srt, sv, se, spr } = parameters
    const stringToSign = [
      this.credential.accountName,
      sp,
      ss,
      srt,
      '',
      se,
      '',
      spr,
      sv,
      '',
      '',
    ].join('\n')

    const url = new URL(this.url)
    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value)
    }
    url.searchParams.set('sig', await this.credential.computeHMACSHA256(stringToSign))
    return url.toString()
  }

  private async *listContainerPages(options?: ListOptions): AsyncGenerator<ListContainersSegment> {
    for await (const { names, continuationToken } of listNames(
      this.transport,
      this.url,
      'Container',
      {},
      options,
    )) {
      yield { segment: { containerItems: names.map((name) => ({ name })) }, continuationToken }
    }
  }
}

/** Validates SAS field characters and returns them in the order the service signs them. */
function canonicalSasCharacters(value: string, canonicalOrder: string, field: string): string {
  const invalid = value.split('').find((character) => !canonicalOrder.includes(character))
  if (invalid !== undefined) {
    throw new RangeError(`Invalid Account SAS ${field} character: ${invalid}`)
  }

  const canonical = canonicalOrder
    .split('')
    .filter((character) => value.includes(character))
    .join('')
  if (canonical.length === 0) {
    throw new RangeError(`Account SAS ${field} cannot be empty`)
  }

  return canonical
}
