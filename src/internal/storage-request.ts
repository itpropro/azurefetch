import { AzureRequestError } from '../azure-request-error'
import { StorageSharedKeyCredential } from '../storage-shared-key-credential'
import { getAuthorizationHeader, storageOAuthScope } from './request-core'
import type { AzureRequestCredential } from './request-core'
import { defaultFetch } from './runtime'
import { encodeUtf8 } from './storage-encoding'
import { getAccountNameFromUrl } from './storage-url'

export const storageServiceVersion = '2024-11-04'

export type StorageCredential = AzureRequestCredential | StorageSharedKeyCredential

export interface StorageClientOptions {
  fetch?: typeof globalThis.fetch
}

export interface StorageRequestInit {
  query?: Partial<Record<string, string>>
  headers?: HeadersInit
  body?: BodyInit
}

interface SignableRequest {
  method: string
  url: URL
  headers: Headers
}

/** Signing scheme and default headers of a storage service. */
export interface StorageProtocol {
  sign: (request: SignableRequest, credential: StorageSharedKeyCredential) => Promise<string>
  headers: HeadersInit
}

const trailingSlash = /\/$/u
const odataVersion = '3.0;NetFx'
const leadingQuestionMark = /^\?/u

export const blobProtocol: StorageProtocol = { sign: signBlobRequest, headers: {} }

export const tableProtocol: StorageProtocol = {
  sign: signTableRequest,
  headers: {
    // Minimal metadata annotates the property types that JSON cannot express.
    Accept: 'application/json;odata=minimalmetadata',
    DataServiceVersion: odataVersion,
    MaxDataServiceVersion: odataVersion,
  },
}

/** Sends authorized Storage REST requests for one client. */
export class StorageTransport {
  private readonly credential: StorageCredential | undefined
  private readonly fetcher: typeof globalThis.fetch
  private readonly protocol: StorageProtocol

  public constructor(
    credential: StorageCredential | undefined,
    options: StorageClientOptions = {},
    protocol: StorageProtocol = blobProtocol,
  ) {
    this.credential = credential
    this.fetcher = options.fetch ?? defaultFetch
    this.protocol = protocol
  }

  public async send(
    method: string,
    target: string,
    init: StorageRequestInit = {},
  ): Promise<Response> {
    const url = new URL(target)
    for (const [name, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, value)
      }
    }

    const headers = new Headers(this.protocol.headers)
    for (const [name, value] of new Headers(init.headers)) {
      headers.set(name, value)
    }
    headers.set('x-ms-date', new Date().toUTCString())
    headers.set('x-ms-version', storageServiceVersion)
    setKnownContentLength(headers, init.body)
    await this.authorize(method, url, headers)

    return await this.fetcher(url, { method, headers, body: init.body })
  }

  /** Sets the Authorization header when the client has a credential; SAS URLs carry their own. */
  public async authorize(method: string, url: URL, headers: Headers): Promise<void> {
    if (this.credential instanceof StorageSharedKeyCredential) {
      headers.set(
        'Authorization',
        await this.protocol.sign({ method, url, headers }, this.credential),
      )
    } else if (this.credential !== undefined) {
      headers.set('Authorization', await getAuthorizationHeader(this.credential, storageOAuthScope))
    }
  }
}

/** Parses an account key or SAS connection string into a service URL and its credential. */
export function parseStorageConnectionString(
  connectionString: string,
  service: 'blob' | 'table',
): { url: string; credential?: StorageSharedKeyCredential } {
  const parts = new Map(
    connectionString
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part): [string, string] => {
        const separator = part.indexOf('=')
        return separator === -1 ? [part, ''] : [part.slice(0, separator), part.slice(separator + 1)]
      }),
  )
  const endpointKey = service === 'blob' ? 'BlobEndpoint' : 'TableEndpoint'
  const endpoint = nonEmpty(parts.get(endpointKey)?.replace(trailingSlash, ''))
  const accountName =
    nonEmpty(parts.get('AccountName')) ??
    (endpoint === undefined ? undefined : nonEmpty(getAccountNameFromUrl(endpoint)))
  const accountKey = parts.get('AccountKey')
  const protocol = parts.get('DefaultEndpointsProtocol')?.toLowerCase()
  const accountSas = parts.get('SharedAccessSignature')

  if (protocol !== undefined && accountKey !== undefined) {
    const endpointSuffix = nonEmpty(parts.get('EndpointSuffix'))
    if (protocol !== 'https' && protocol !== 'http') {
      throw new Error(
        "Invalid DefaultEndpointsProtocol in the provided Connection String. Expecting 'https' or 'http'",
      )
    }

    if (endpoint === undefined && endpointSuffix === undefined) {
      throw new Error('Invalid EndpointSuffix in the provided Connection String')
    }

    if (accountName === undefined) {
      throw new Error('Invalid AccountName in the provided Connection String')
    }

    return {
      url: endpoint ?? `${protocol}://${accountName}.${service}.${endpointSuffix}`,
      credential: new StorageSharedKeyCredential(accountName, accountKey),
    }
  }

  if (accountSas !== undefined) {
    if (endpoint === undefined) {
      throw new Error(`Invalid ${endpointKey} in the provided SAS Connection String`)
    }

    const url = new URL(endpoint)
    url.search = accountSas.replace(leadingQuestionMark, '')
    return { url: url.toString() }
  }

  throw new Error(
    'Connection string must be either an Account connection string or a SAS connection string',
  )
}

/** Shared key signatures cover Content-Length, so it is set explicitly for bodies of known size. */
function setKnownContentLength(headers: Headers, body: BodyInit | null | undefined): void {
  let length: number | undefined
  if (typeof body === 'string') {
    length = encodeUtf8(body).byteLength
  } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    length = body.byteLength
  } else if (body instanceof Blob) {
    length = body.size
  }

  if (length !== undefined) {
    headers.set('Content-Length', String(length))
  }
}

/** Shared Key scheme of the Blob service. */
async function signBlobRequest(
  { method, url, headers }: SignableRequest,
  credential: StorageSharedKeyCredential,
): Promise<string> {
  const contentLength = headers.get('Content-Length')
  const stringToSign = [
    method.toUpperCase(),
    headers.get('Content-Encoding') ?? '',
    headers.get('Content-Language') ?? '',
    contentLength === '0' ? '' : (contentLength ?? ''),
    headers.get('Content-MD5') ?? '',
    headers.get('Content-Type') ?? '',
    '',
    headers.get('If-Modified-Since') ?? '',
    headers.get('If-Match') ?? '',
    headers.get('If-None-Match') ?? '',
    headers.get('If-Unmodified-Since') ?? '',
    headers.get('Range') ?? '',
    // Headers iterate with lowercase names in sorted order.
    ...Array.from(headers)
      .filter(([name]) => name.startsWith('x-ms-'))
      .map(([name, value]) => `${name}:${value.trim()}`),
    canonicalizeBlobResource(url, credential.accountName),
  ].join('\n')

  return `SharedKey ${credential.accountName}:${await credential.computeHMACSHA256(stringToSign)}`
}

/** Shared Key Lite scheme of the Table service. */
async function signTableRequest(
  { url, headers }: SignableRequest,
  credential: StorageSharedKeyCredential,
): Promise<string> {
  const comp = url.searchParams.get('comp')
  const resource = `/${credential.accountName}${url.pathname}${comp === null ? '' : `?comp=${comp}`}`
  const stringToSign = `${headers.get('x-ms-date') ?? ''}\n${resource}`

  return `SharedKeyLite ${credential.accountName}:${await credential.computeHMACSHA256(stringToSign)}`
}

function canonicalizeBlobResource(url: URL, accountName: string): string {
  const values = new Map<string, string[]>()
  for (const [name, value] of url.searchParams) {
    const key = name.toLowerCase()
    values.set(key, [...(values.get(key) ?? []), value])
  }

  const names = [...values.keys()]
  names.sort()
  const parameters = names.map((name) => {
    const sorted = values.get(name) ?? []
    sorted.sort()
    return `${name}:${sorted.join(',')}`
  })

  return [`/${accountName}${url.pathname}`, ...parameters].join('\n')
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value
}

export function storageRequestError(operation: string, response: Response): AzureRequestError {
  return new AzureRequestError(
    `${operation} failed: ${response.status} ${response.statusText}`,
    response.status,
    response.headers.get('x-ms-error-code') ?? undefined,
  )
}

/** Account name of a service URL; Shared Key clients need a URL that names the account. */
export function storageAccountName(url: string, credential: StorageCredential | undefined): string {
  const accountName = getAccountNameFromUrl(url)
  if (credential instanceof StorageSharedKeyCredential && accountName === '') {
    throw new Error(
      'Unable to extract accountName from provided URL for StorageSharedKeyCredential',
    )
  }

  return accountName
}

export function multipartBoundary(prefix: string): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  )
  return `${prefix}_${random.join('')}`
}
