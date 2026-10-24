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

type SharedKeySigner = (
  method: string,
  url: URL,
  headers: Headers,
  credential: StorageSharedKeyCredential,
) => Promise<string>

const trailingSlash = /\/$/u
const leadingQuestionMark = /^\?/u

/** Sends authorized Storage REST requests for one client. */
export class StorageTransport {
  private readonly credential: StorageCredential | undefined
  private readonly fetcher: typeof globalThis.fetch
  private readonly signSharedKey: SharedKeySigner

  public constructor(
    credential: StorageCredential | undefined,
    options: StorageClientOptions = {},
    signSharedKey: SharedKeySigner = applyBlobSharedKeyAuth,
  ) {
    this.credential = credential
    this.fetcher = options.fetch ?? defaultFetch
    this.signSharedKey = signSharedKey
  }

  public async send(
    method: string,
    target: string,
    init: StorageRequestInit = {},
  ): Promise<Response> {
    const url = new URL(target)
    addQueryParameters(url, init.query)
    const headers = new Headers(init.headers)
    applyStorageDateAndVersionHeaders(headers)
    setKnownContentLength(headers, init.body)
    await this.authorize(method, url, headers)

    return await this.fetcher(url, { method, headers, body: init.body })
  }

  /** Sets the Authorization header when the client has a credential; SAS URLs carry their own. */
  public async authorize(method: string, url: URL, headers: Headers): Promise<void> {
    if (this.credential instanceof StorageSharedKeyCredential) {
      headers.set('Authorization', await this.signSharedKey(method, url, headers, this.credential))
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

export function addQueryParameters(url: URL, query: Partial<Record<string, string>> = {}): void {
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(name, value)
    }
  }
}

export function applyStorageDateAndVersionHeaders(
  headers: Headers,
  version = storageServiceVersion,
): void {
  if (!headers.has('x-ms-date')) {
    headers.set('x-ms-date', new Date().toUTCString())
  }

  if (!headers.has('x-ms-version')) {
    headers.set('x-ms-version', version)
  }
}

/** Shared key signatures cover Content-Length, so it is set explicitly for bodies of known size. */
export function setKnownContentLength(headers: Headers, body: BodyInit | null | undefined): void {
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
export async function applyBlobSharedKeyAuth(
  method: string,
  url: URL,
  headers: Headers,
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
export async function applyTableSharedKeyLiteAuth(
  _method: string,
  url: URL,
  headers: Headers,
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

  return [
    `/${accountName}${url.pathname}`,
    ...[...values.keys()]
      .toSorted()
      .map((name) => `${name}:${values.get(name)?.toSorted().join(',')}`),
  ].join('\n')
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
