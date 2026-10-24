import { AzureClient } from './client'
import type { AzureClientCredential, AzureRequestInit, AzureRequestOverrides } from './client'
import { AppConfigurationKeyCredential } from './internal/app-configuration-credential'
import { jsonProperty, readBoolean, readString, readStringRecord } from './internal/json'
import { pagedItems, paginate } from './internal/paging'
import type { PagedAsyncIterableIterator, PageSettings } from './internal/paging'
import { appConfigurationOAuthScope } from './internal/request-core'
import { jsonRequestError } from './internal/request-error'
import { normalizeServiceUrl } from './internal/url'

const defaultApiVersion = '2023-11-01'
const settingContentType = 'application/vnd.microsoft.appconfig.kv+json'
const settingAccept = 'application/vnd.microsoft.appconfig.kv+json, application/problem+json'
const listAccept = 'application/vnd.microsoft.appconfig.kvset+json, application/problem+json'
const connectionStringPattern = /Endpoint=(.*);Id=(.*);Secret=(.*)/u
const syncTokenPattern = /^([^=]+)=([^;]+);sn=(\d+)$/u
const reservedFilterCharacter = /([\\*,])/gu
const surroundingColons = /^:+|:+$/gu

export interface AppConfigurationClientOptions extends Omit<AzureRequestOverrides, 'credential'> {
  fetch?: typeof globalThis.fetch
  apiVersion?: string
  /** Prepended to keys as `prefix:key` and removed from returned keys. */
  prefix?: string
  /** Default label; `null` selects settings without a label. */
  label?: string | null
}

export type AppConfigurationRequestOptions = Omit<AzureRequestInit, 'method' | 'body'>

export interface ConfigurationSetting {
  key: string
  label?: string
  contentType?: string
  value?: string
  lastModified?: Date
  tags?: Record<string, string>
  isReadOnly: boolean
  etag?: string
}

export interface ConfigurationSettingPage {
  value: ConfigurationSetting[]
  continuationToken?: string
}

export interface GetConfigurationSettingOptions extends AppConfigurationRequestOptions {
  label?: string | null
}

export type DeleteConfigurationSettingOptions = GetConfigurationSettingOptions

export interface SetConfigurationSettingOptions extends AppConfigurationRequestOptions {
  label?: string | null
  contentType?: string
  tags?: Record<string, string>
}

export interface ListConfigurationSettingsOptions extends AppConfigurationRequestOptions {
  keyFilter?: string
  /** `null` selects settings without a label. */
  labelFilter?: string | null
}

export class AppConfigurationClient {
  public readonly url: string
  private readonly client: AzureClient
  private readonly apiVersion: string
  private readonly prefix: string | undefined
  private readonly defaultLabel: string | null | undefined
  private readonly syncTokens = new Map<string, { token: string; sequenceNumber: number }>()

  public constructor(
    endpoint: string,
    credential?: AzureClientCredential,
    options: AppConfigurationClientOptions = {},
  ) {
    this.url = normalizeServiceUrl(endpoint, 'endpoint')
    this.apiVersion = options.apiVersion ?? defaultApiVersion
    const prefix = options.prefix?.trim().replaceAll(surroundingColons, '')
    this.prefix = prefix === '' ? undefined : prefix
    this.defaultLabel = options.label
    this.client = new AzureClient({
      credential,
      fetch: options.fetch,
      retryOptions: options.retryOptions,
      scope: options.scope ?? appConfigurationScope(this.url),
      authorityHost: options.authorityHost,
    })
  }

  public static fromConnectionString(
    connectionString: string,
    options: Omit<AppConfigurationClientOptions, 'scope' | 'authorityHost'> = {},
  ): AppConfigurationClient {
    const [, endpoint = '', id = '', secret = ''] =
      connectionStringPattern.exec(connectionString) ?? []
    if (endpoint === '') {
      throw new Error('Invalid connection string. Expected Endpoint=…;Id=…;Secret=…')
    }

    return new AppConfigurationClient(
      endpoint,
      new AppConfigurationKeyCredential(id, secret),
      options,
    )
  }

  /** Adds sync tokens, for example from Event Grid notifications; malformed tokens are ignored. */
  public updateSyncToken(syncToken: string): void {
    for (const token of syncToken.split(',')) {
      const [, id, value, sequence] = syncTokenPattern.exec(token.trim()) ?? []
      if (id === undefined || value === undefined || sequence === undefined) {
        continue
      }

      const sequenceNumber = Number(sequence)
      if ((this.syncTokens.get(id)?.sequenceNumber ?? -1) < sequenceNumber) {
        this.syncTokens.set(id, { token: `${id}=${value}`, sequenceNumber })
      }
    }
  }

  public async getConfigurationSetting(
    key: string,
    options: GetConfigurationSettingOptions = {},
  ): Promise<ConfigurationSetting> {
    const { label, ...init } = options
    const response = await this.send('GET', this.settingUrl(key, label), init, settingAccept)
    return this.parseSetting(await response.json())
  }

  public async setConfigurationSetting(
    key: string,
    value: string,
    options: SetConfigurationSettingOptions = {},
  ): Promise<ConfigurationSetting> {
    const { label, contentType, tags, ...init } = options
    const url = this.settingUrl(key, label)
    const body = JSON.stringify({
      key: this.resolveKey(key),
      label: url.searchParams.get('label') ?? undefined,
      value,
      content_type: contentType,
      tags,
    })
    const response = await this.send('PUT', url, init, settingAccept, body)
    return this.parseSetting(await response.json())
  }

  public async deleteConfigurationSetting(
    key: string,
    options: DeleteConfigurationSettingOptions = {},
  ): Promise<ConfigurationSetting | undefined> {
    const { label, ...init } = options
    const response = await this.send('DELETE', this.settingUrl(key, label), init, settingAccept)
    return response.status === 204 ? undefined : this.parseSetting(await response.json())
  }

  public listConfigurationSettings(
    options: ListConfigurationSettingsOptions = {},
  ): PagedAsyncIterableIterator<ConfigurationSetting, ConfigurationSettingPage> {
    const { keyFilter, labelFilter, ...init } = options
    const defaultKeyFilter = this.prefix === undefined ? '*' : `${escapeFilter(this.prefix)}:*`

    return pagedItems((settings: PageSettings = {}) =>
      paginate(async (after) => {
        const url = new URL('kv', `${this.url}/`)
        url.searchParams.set('key', keyFilter ?? defaultKeyFilter)
        const label = this.resolveLabelFilter(labelFilter)
        if (label !== undefined) {
          url.searchParams.set('label', label)
        }
        if (after !== undefined) {
          url.searchParams.set('after', after)
        }

        const payload: unknown = await (await this.send('GET', url, init, listAccept)).json()
        const items = jsonProperty(payload, 'items')
        const nextLink = readString(payload, '@nextLink')
        const continuationToken =
          nextLink === undefined
            ? undefined
            : (new URL(nextLink, this.url).searchParams.get('after') ?? undefined)
        const value = Array.isArray(items) ? items.map((item) => this.parseSetting(item)) : []
        return { page: { value, continuationToken }, continuationToken }
      }, settings.continuationToken),
    )
  }

  private settingUrl(key: string, label: string | null | undefined): URL {
    const url = new URL(`kv/${encodeURIComponent(this.resolveKey(key))}`, `${this.url}/`)
    const resolvedLabel = label === undefined ? this.defaultLabel : label
    if (typeof resolvedLabel === 'string') {
      url.searchParams.set('label', resolvedLabel)
    }

    return url
  }

  private resolveKey(key: string): string {
    if (key.trim().length === 0) {
      throw new TypeError('Configuration setting key must be a non-empty string')
    }

    return this.prefix === undefined ? key : `${this.prefix}:${key}`
  }

  /** `\0` selects settings without a label; generated filters escape reserved characters. */
  private resolveLabelFilter(labelFilter: string | null | undefined): string | undefined {
    if (labelFilter !== undefined) {
      return labelFilter ?? '\0'
    }

    if (this.defaultLabel === null) {
      return '\0'
    }

    return this.defaultLabel === undefined ? undefined : escapeFilter(this.defaultLabel)
  }

  private parseSetting(item: unknown): ConfigurationSetting {
    const key = readString(item, 'key')
    if (key === undefined) {
      throw new TypeError('App Configuration response did not include a key')
    }

    const lastModified = readString(item, 'last_modified')
    const prefix = this.prefix === undefined ? undefined : `${this.prefix}:`
    return {
      key: prefix !== undefined && key.startsWith(prefix) ? key.slice(prefix.length) : key,
      label: readString(item, 'label'),
      contentType: readString(item, 'content_type'),
      value: readString(item, 'value'),
      lastModified: lastModified === undefined ? undefined : new Date(lastModified),
      tags: readStringRecord(item, 'tags'),
      isReadOnly: readBoolean(item, 'locked') ?? false,
      etag: readString(item, 'etag'),
    }
  }

  private async send(
    method: string,
    url: URL,
    options: AppConfigurationRequestOptions,
    accept: string,
    body?: string,
  ): Promise<Response> {
    url.searchParams.set('api-version', this.apiVersion)
    // Sorted query parameters keep request URLs cache friendly, as the official SDK does.
    url.searchParams.sort()
    const headers = new Headers(options.headers)
    headers.set('Accept', accept)
    if (body !== undefined) {
      headers.set('Content-Type', settingContentType)
    }

    const syncToken = Array.from(this.syncTokens.values(), ({ token }) => token).join(',')
    if (syncToken !== '' && !headers.has('Sync-Token')) {
      headers.set('Sync-Token', syncToken)
    }

    const response = await this.client.fetch(url, { ...options, method, headers, body })
    this.updateSyncToken(response.headers.get('sync-token') ?? '')
    if (!response.ok) {
      throw await jsonRequestError(`${method} ${url.toString()}`, response, (problem) => ({
        code: jsonProperty(problem, 'name'),
        message: jsonProperty(problem, 'detail') ?? jsonProperty(problem, 'title'),
      }))
    }

    return response
  }
}

function escapeFilter(value: string): string {
  return value.replaceAll(reservedFilterCharacter, String.raw`\$1`)
}

function appConfigurationScope(endpoint: string): string {
  const { host } = new URL(endpoint)
  for (const cloud of ['azure.us', 'azure.cn']) {
    if (host.endsWith(`azconfig.${cloud}`) || host.endsWith(`appconfig.${cloud}`)) {
      return `https://appconfig.${cloud}/.default`
    }
  }

  return appConfigurationOAuthScope
}
