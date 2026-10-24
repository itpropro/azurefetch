import { AzureClient } from './client'
import type { AzureRequestInit, AzureRequestOverrides } from './client'
import {
  jsonProperty,
  readBoolean,
  readNumber,
  readString,
  readStringRecord,
} from './internal/json'
import { pagedItems, paginate } from './internal/paging'
import type { PagedAsyncIterableIterator, PageSettings } from './internal/paging'
import { keyVaultOAuthScope } from './internal/request-core'
import type { AzureRequestCredential } from './internal/request-core'
import { jsonRequestError } from './internal/request-error'
import { normalizeServiceUrl } from './internal/url'

const keyVaultApiVersion = '7.6'

export interface KeyVaultClientOptions extends Omit<AzureRequestOverrides, 'credential'> {
  fetch?: typeof globalThis.fetch
}

export type KeyVaultRequestOptions = Omit<AzureRequestInit, 'method' | 'body'>

export interface SecretAttributesOptions extends KeyVaultRequestOptions {
  contentType?: string
  enabled?: boolean
  notBefore?: Date
  expiresOn?: Date
  tags?: Record<string, string>
}

export interface GetSecretOptions extends KeyVaultRequestOptions {
  version?: string
}

export interface SecretProperties {
  vaultUrl: string
  name: string
  version?: string
  id?: string
  contentType?: string
  enabled?: boolean
  notBefore?: Date
  expiresOn?: Date
  tags?: Record<string, string>
  certificateKeyId?: string
  managed?: boolean
  createdOn?: Date
  updatedOn?: Date
  recoveryLevel?: string
  recoverableDays?: number
  recoveryId?: string
  scheduledPurgeDate?: Date
  deletedOn?: Date
}

export interface KeyVaultSecret {
  name: string
  value?: string
  properties: SecretProperties
}

export interface DeletedSecret extends KeyVaultSecret {
  recoveryId?: string
  scheduledPurgeDate?: Date
  deletedOn?: Date
}

export interface SecretPage<T> {
  value: T[]
  continuationToken?: string
}

interface SecretRequestBody {
  value?: string
  contentType: string | undefined
  tags: Record<string, string> | undefined
  attributes: ReturnType<typeof serializeAttributes>
}

export class KeyVaultSecretClient {
  public readonly url: string
  private readonly client: AzureClient

  public constructor(
    vaultUrl: string,
    credential?: AzureRequestCredential,
    options: KeyVaultClientOptions = {},
  ) {
    this.url = normalizeServiceUrl(vaultUrl, 'vaultUrl')
    this.client = new AzureClient({
      credential,
      fetch: options.fetch,
      scope: options.scope ?? keyVaultOAuthScope,
      authorityHost: options.authorityHost,
    })
  }

  public async setSecret(
    name: string,
    value: string,
    options: SecretAttributesOptions = {},
  ): Promise<KeyVaultSecret> {
    const { contentType, tags, enabled, notBefore, expiresOn, ...init } = options
    const attributes = serializeAttributes({ enabled, notBefore, expiresOn })
    const payload = await this.send('PUT', this.secretUrl(name), init, {
      value,
      contentType,
      tags,
      attributes,
    })
    return parseSecret(payload, this.url, name)
  }

  public async getSecret(name: string, options: GetSecretOptions = {}): Promise<KeyVaultSecret> {
    const { version, ...init } = options
    return parseSecret(await this.send('GET', this.secretUrl(name, version), init), this.url, name)
  }

  public async updateSecretProperties(
    name: string,
    version = '',
    options: SecretAttributesOptions = {},
  ): Promise<SecretProperties> {
    const { contentType, tags, enabled, notBefore, expiresOn, ...init } = options
    const attributes = serializeAttributes({ enabled, notBefore, expiresOn })
    const payload = await this.send('PATCH', this.secretUrl(name, version), init, {
      contentType,
      tags,
      attributes,
    })
    return parseSecretProperties(payload, this.url, name)
  }

  public async deleteSecret(
    name: string,
    options: KeyVaultRequestOptions = {},
  ): Promise<DeletedSecret> {
    const payload = await this.send('DELETE', this.secretUrl(name), options)
    return parseDeletedSecret(payload, this.url, name)
  }

  public async getDeletedSecret(
    name: string,
    options: KeyVaultRequestOptions = {},
  ): Promise<DeletedSecret> {
    const payload = await this.send('GET', this.deletedSecretUrl(name), options)
    return parseDeletedSecret(payload, this.url, name)
  }

  public async purgeDeletedSecret(
    name: string,
    options: KeyVaultRequestOptions = {},
  ): Promise<void> {
    await this.send('DELETE', this.deletedSecretUrl(name), options)
  }

  public async recoverDeletedSecret(
    name: string,
    options: KeyVaultRequestOptions = {},
  ): Promise<KeyVaultSecret> {
    const payload = await this.send('POST', `${this.deletedSecretUrl(name)}/recover`, options)
    return parseSecret(payload, this.url, name)
  }

  public listPropertiesOfSecrets(
    options: KeyVaultRequestOptions = {},
  ): PagedAsyncIterableIterator<SecretProperties, SecretPage<SecretProperties>> {
    return this.list(`${this.url}/secrets`, options, (item) =>
      parseSecretProperties(item, this.url),
    )
  }

  public listDeletedSecrets(
    options: KeyVaultRequestOptions = {},
  ): PagedAsyncIterableIterator<DeletedSecret, SecretPage<DeletedSecret>> {
    return this.list(`${this.url}/deletedsecrets`, options, (item) =>
      parseDeletedSecret(item, this.url),
    )
  }

  public listPropertiesOfSecretVersions(
    name: string,
    options: KeyVaultRequestOptions = {},
  ): PagedAsyncIterableIterator<SecretProperties, SecretPage<SecretProperties>> {
    return this.list(`${this.secretUrl(name)}/versions`, options, (item) =>
      parseSecretProperties(item, this.url, name),
    )
  }

  private list<T>(
    url: string,
    options: KeyVaultRequestOptions,
    parse: (item: unknown) => T,
  ): PagedAsyncIterableIterator<T, SecretPage<T>> {
    return pagedItems((settings: PageSettings = {}) =>
      paginate(async (link) => {
        const payload = await this.send('GET', this.pageUrl(link ?? url), options)
        const items = jsonProperty(payload, 'value')
        const nextLink = readString(payload, 'nextLink')
        const continuationToken = nextLink === '' ? undefined : nextLink
        return {
          page: {
            value: Array.isArray(items) ? items.map((item) => parse(item)) : [],
            continuationToken,
          },
          continuationToken,
        }
      }, settings.continuationToken),
    )
  }

  private secretUrl(name: string, version?: string): string {
    if (name.trim().length === 0) {
      throw new TypeError('Secret name must be a non-empty string')
    }

    const url = `${this.url}/secrets/${encodeURIComponent(name)}`
    return version === undefined ? url : `${url}/${encodeURIComponent(version)}`
  }

  private deletedSecretUrl(name: string): string {
    return this.secretUrl(name).replace('/secrets/', '/deletedsecrets/')
  }

  /** Continuation links come from the service; they must stay on the configured vault. */
  private pageUrl(link: string): string {
    const url = new URL(link, `${this.url}/`)
    if (url.origin !== new URL(this.url).origin) {
      throw new TypeError('Key Vault continuation URL must match the configured vault origin')
    }

    return url.toString()
  }

  private async send(
    method: string,
    target: string,
    options: KeyVaultRequestOptions,
    body?: SecretRequestBody,
  ): Promise<unknown> {
    const url = new URL(target)
    if (!url.searchParams.has('api-version')) {
      url.searchParams.set('api-version', keyVaultApiVersion)
    }

    const headers = new Headers(options.headers)
    headers.set('Accept', 'application/json')
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json')
    }

    const response = await this.client.fetch(url, {
      ...options,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      throw await jsonRequestError(`${method} ${url.toString()}`, response, (payload) => {
        const error = jsonProperty(payload, 'error')
        return { code: jsonProperty(error, 'code'), message: jsonProperty(error, 'message') }
      })
    }

    return response.status === 204 ? undefined : await response.json()
  }
}

function serializeAttributes(attributes: {
  enabled: boolean | undefined
  notBefore: Date | undefined
  expiresOn: Date | undefined
}): { enabled?: boolean; nbf?: number; exp?: number } | undefined {
  const { enabled, notBefore, expiresOn } = attributes
  if (enabled === undefined && notBefore === undefined && expiresOn === undefined) {
    return undefined
  }

  return { enabled, nbf: toEpochSeconds(notBefore), exp: toEpochSeconds(expiresOn) }
}

function toEpochSeconds(date: Date | undefined): number | undefined {
  return date === undefined ? undefined : Math.floor(date.getTime() / 1000)
}

function epochSecondsDate(value: unknown, key: string): Date | undefined {
  const seconds = readNumber(value, key)
  return seconds === undefined ? undefined : new Date(seconds * 1000)
}

/** Secret identifiers look like `https://vault/secrets/{name}/{version}`. */
function parseSecretProperties(
  payload: unknown,
  vaultUrl: string,
  fallbackName = '',
): SecretProperties {
  const id = readString(payload, 'id')
  const identifier = id === undefined ? undefined : new URL(id)
  const [, name, version] =
    identifier?.pathname
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment)) ?? []
  const attributes = jsonProperty(payload, 'attributes')

  return {
    vaultUrl: identifier?.origin ?? vaultUrl,
    name: name ?? fallbackName,
    version,
    id,
    contentType: readString(payload, 'contentType'),
    enabled: readBoolean(attributes, 'enabled'),
    notBefore: epochSecondsDate(attributes, 'nbf'),
    expiresOn: epochSecondsDate(attributes, 'exp'),
    tags: readStringRecord(payload, 'tags'),
    certificateKeyId: readString(payload, 'kid'),
    managed: readBoolean(payload, 'managed'),
    createdOn: epochSecondsDate(attributes, 'created'),
    updatedOn: epochSecondsDate(attributes, 'updated'),
    recoveryLevel: readString(attributes, 'recoveryLevel'),
    recoverableDays: readNumber(attributes, 'recoverableDays'),
  }
}

function parseSecret(payload: unknown, vaultUrl: string, fallbackName?: string): KeyVaultSecret {
  const properties = parseSecretProperties(payload, vaultUrl, fallbackName)
  return { name: properties.name, value: readString(payload, 'value'), properties }
}

function parseDeletedSecret(
  payload: unknown,
  vaultUrl: string,
  fallbackName?: string,
): DeletedSecret {
  const deletion = {
    recoveryId: readString(payload, 'recoveryId'),
    deletedOn: epochSecondsDate(payload, 'deletedDate'),
    scheduledPurgeDate: epochSecondsDate(payload, 'scheduledPurgeDate'),
  }
  const secret = parseSecret(payload, vaultUrl, fallbackName)
  return { ...secret, ...deletion, properties: { ...secret.properties, ...deletion } }
}
