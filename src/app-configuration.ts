import { AzureFetchError } from "./errors";
import { appConfigurationOAuthScope, type AzureRequestCredential } from "./internal/request-core";
import { decodeBase64ToBytes, encodeBytesToBase64, encodeUtf8 } from "./internal/storage-encoding";
import { AzureClient, type AzureRequestInit, type AzureRequestOverrides } from "./client";

const defaultApiVersion = "2023-11-01";
const configurationSettingContentType = "application/vnd.microsoft.appconfig.kv+json";
const configurationSettingAccept = "application/vnd.microsoft.appconfig.kv+json, application/problem+json";
const configurationSettingListAccept = "application/vnd.microsoft.appconfig.kvset+json, application/problem+json";
const signedHeaders = "x-ms-date;host;x-ms-content-sha256";
const connectionStringRegex = /Endpoint=(.*);Id=(.*);Secret=(.*)/;
const syncTokenRegex = /^([^=]+)=([^;]+);sn=(\d+)$/;
const reservedQueryCharacterRegex = /([\\*,])/g;

interface HmacCredential {
  sign(method: string, url: URL, headers: Headers, body: string): Promise<void>;
}

interface SyncTokenState {
  id: string;
  value: string;
  sequenceNumber: number;
}

export interface AppConfigurationClientOptions extends AzureRequestOverrides {
  fetch?: typeof globalThis.fetch;
  apiVersion?: string;
  prefix?: string;
  label?: string | null;
}

type AppConfigurationRequestOptions = Omit<AzureRequestInit, "method" | "body">;

export type ConfigurationSettingField = keyof ConfigurationSetting;

export interface ConfigurationSetting {
  key: string;
  label?: string;
  contentType?: string;
  value?: string;
  lastModified?: Date;
  tags?: Record<string, string>;
  isReadOnly: boolean;
  etag?: string;
}

export interface AppConfigurationPageSettings {
  continuationToken?: string;
}

export interface ConfigurationSettingPage {
  response: Response;
  value: ConfigurationSetting[];
  continuationToken?: string;
  etag?: string;
}

export interface GetConfigurationSettingOptions extends AppConfigurationRequestOptions {
  label?: string | null;
  acceptDateTime?: Date;
  fields?: ConfigurationSettingField[];
}

export interface SetConfigurationSettingOptions extends AppConfigurationRequestOptions {
  label?: string | null;
  contentType?: string;
  tags?: Record<string, string>;
}

export interface DeleteConfigurationSettingOptions extends AppConfigurationRequestOptions {
  label?: string | null;
}

export interface ListConfigurationSettingsOptions extends AppConfigurationRequestOptions {
  keyFilter?: string;
  labelFilter?: string | null;
  fields?: ConfigurationSettingField[];
  acceptDateTime?: Date;
  tagsFilter?: string[];
}

export interface PagedAsyncIterableIterator<T, TPage> extends AsyncIterable<T> {
  byPage(settings?: AppConfigurationPageSettings): AsyncIterable<TPage>;
}

export class AppConfigurationRequestError extends AzureFetchError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorCode?: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export class AppConfigurationClient {
  public readonly url: string;

  private readonly apiVersion: string;

  private readonly fetcher: typeof globalThis.fetch;

  private readonly prefix?: string;

  private readonly defaultLabel?: string | null;

  private tokenClient?: AzureClient;

  private hmacCredential?: HmacCredential;

  private readonly syncTokens = new Map<string, SyncTokenState>();

  constructor(endpoint: string, credential?: AzureRequestCredential, options: AppConfigurationClientOptions = {}) {
    this.url = normalizeEndpoint(endpoint);
    this.apiVersion = options.apiVersion ?? defaultApiVersion;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.prefix = normalizePrefix(options.prefix);
    this.defaultLabel = options.label;
    this.tokenClient = new AzureClient({
      credential,
      fetch: this.fetcher,
      scope: options.scope ?? getAppConfigurationScope(this.url),
      authorityHost: options.authorityHost,
    });
  }

  public static fromConnectionString(
    connectionString: string,
    options: Omit<AppConfigurationClientOptions, "credential" | "scope" | "authorityHost"> = {},
  ): AppConfigurationClient {
    const parsed = parseConnectionString(connectionString);
    const client = new AppConfigurationClient(parsed.endpoint, undefined, options);
    client.tokenClient = undefined;
    client.hmacCredential = new AppConfigurationConnectionStringCredential(parsed.id, parsed.secret);
    return client;
  }

  public updateSyncToken(syncToken: string): void {
    this.addSyncTokenHeaderValue(syncToken);
  }

  public async getConfigurationSetting(
    key: string,
    options: GetConfigurationSettingOptions = {},
  ): Promise<ConfigurationSetting> {
    const requestUrl = buildKeyValueUrl(this.url, this.resolveKey(key), this.apiVersion);
    const label = this.resolveLabel(options.label);
    const headers = new Headers(options.headers ?? {});
    headers.set("Accept", configurationSettingAccept);
    applyAcceptDateTime(headers, options.acceptDateTime);

    const query = createQueryParameters({
      label: label ?? undefined,
      $select: formatFieldsForSelect(options.fields),
    });

    const response = await this.request("GET", requestUrl, {
      ...options,
      headers,
      query,
    });

    return parseConfigurationSetting(await parseJsonResponse(response), this.prefix);
  }

  public async setConfigurationSetting(
    key: string,
    value: string,
    options: SetConfigurationSettingOptions = {},
  ): Promise<ConfigurationSetting> {
    const resolvedKey = this.resolveKey(key);
    const label = this.resolveLabel(options.label);
    const requestUrl = buildKeyValueUrl(this.url, resolvedKey, this.apiVersion);
    const headers = new Headers(options.headers ?? {});
    headers.set("Accept", configurationSettingAccept);
    headers.set("Content-Type", configurationSettingContentType);

    const body = JSON.stringify({
      key: resolvedKey,
      label: label ?? undefined,
      value,
      content_type: options.contentType,
      tags: options.tags,
    });

    const response = await this.request("PUT", requestUrl, {
      ...options,
      headers,
      body,
      query: createQueryParameters({
        label: label ?? undefined,
      }),
    });

    return parseConfigurationSetting(await parseJsonResponse(response), this.prefix);
  }

  public async deleteConfigurationSetting(
    key: string,
    options: DeleteConfigurationSettingOptions = {},
  ): Promise<ConfigurationSetting | undefined> {
    const requestUrl = buildKeyValueUrl(this.url, this.resolveKey(key), this.apiVersion);
    const label = this.resolveLabel(options.label);
    const headers = new Headers(options.headers ?? {});
    headers.set("Accept", configurationSettingAccept);

    const response = await this.request("DELETE", requestUrl, {
      ...options,
      headers,
      query: createQueryParameters({
        label: label ?? undefined,
      }),
    });

    if (response.status === 204) {
      return undefined;
    }

    return parseConfigurationSetting(await parseJsonResponse(response), this.prefix);
  }

  public listConfigurationSettings(
    options: ListConfigurationSettingsOptions = {},
  ): PagedAsyncIterableIterator<ConfigurationSetting, ConfigurationSettingPage> {
    return createPagedAsyncIterable(async (settings) => {
      return this.fetchConfigurationSettingPage(options, settings);
    });
  }

  private async fetchConfigurationSettingPage(
    options: ListConfigurationSettingsOptions,
    settings: AppConfigurationPageSettings | undefined,
  ): Promise<ConfigurationSettingPage> {
    const headers = new Headers(options.headers ?? {});
    headers.set("Accept", configurationSettingListAccept);
    applyAcceptDateTime(headers, options.acceptDateTime);

    const labelFilter = this.resolveLabelFilter(options.labelFilter);
    const requestUrl = buildListUrl(this.url, this.apiVersion, settings?.continuationToken);
    const response = await this.request("GET", requestUrl, {
      ...options,
      headers,
      query: createQueryParameters({
        key: options.keyFilter ?? defaultKeyFilter(this.prefix),
        label: labelFilter,
        $select: formatFieldsForSelect(options.fields),
        tags: options.tagsFilter,
      }),
    });

    const payload = parseConfigurationSettingList(await parseJsonResponse(response), this.prefix, this.url);
    return {
      response,
      value: payload.value,
      continuationToken: payload.continuationToken,
      etag: payload.etag,
    };
  }

  private resolveKey(key: string): string {
    if (key.trim().length === 0) {
      throw new TypeError("Configuration setting key must be a non-empty string");
    }

    if (this.prefix == null) {
      return key;
    }

    return `${this.prefix}:${key}`;
  }

  private resolveLabel(label: string | null | undefined): string | null | undefined {
    if (label !== undefined) {
      return label;
    }

    return this.defaultLabel;
  }

  private resolveLabelFilter(labelFilter: string | null | undefined): string | undefined {
    if (labelFilter !== undefined) {
      if (labelFilter === null) {
        return "\0";
      }

      return labelFilter;
    }

    if (this.defaultLabel === null) {
      return "\0";
    }

    return this.defaultLabel == null ? undefined : escapeQueryLiteral(this.defaultLabel);
  }

  private async request(
    method: string,
    input: string,
    options: AppConfigurationRequestOptions & { body?: string; query?: QueryValueMap } = {},
  ): Promise<Response> {
    const url = createNormalizedRequestUrl(input, options.query);
    const headers = new Headers(options.headers ?? {});
    this.applySyncTokenHeader(headers);
    const body = options.body ?? "";

    let response: Response;
    if (this.hmacCredential != null) {
      await this.hmacCredential.sign(method, url, headers, body);
      response = await this.fetcher(url.toString(), {
        ...options,
        method,
        headers,
        body: options.body,
      });
    } else {
      response = await this.tokenClient!.fetch(url.toString(), {
        ...options,
        method,
        headers,
        body: options.body,
      });
    }

    this.addSyncTokenHeaderValue(response.headers.get("sync-token") ?? undefined);

    if (!isExpectedStatus(response.status)) {
      throw await createAppConfigurationRequestError(`${method} ${url.toString()}`, response);
    }

    return response;
  }

  private applySyncTokenHeader(headers: Headers): void {
    const headerValue = formatSyncTokenHeaderValue(this.syncTokens);
    if (headerValue != null && !headers.has("Sync-Token")) {
      headers.set("Sync-Token", headerValue);
    }
  }

  private addSyncTokenHeaderValue(value: string | undefined): void {
    if (value == null || value.length === 0) {
      return;
    }

    for (const token of value.split(",")) {
      const parsed = parseSyncToken(token);
      const current = this.syncTokens.get(parsed.id);
      if (current == null || current.sequenceNumber < parsed.sequenceNumber) {
        this.syncTokens.set(parsed.id, parsed);
      }
    }
  }
}

class AppConfigurationConnectionStringCredential implements HmacCredential {
  private readonly secretBytes: ArrayBuffer;

  private importedKeyPromise?: Promise<CryptoKey>;

  constructor(
    private readonly id: string,
    secret: string,
  ) {
    const decoded = Uint8Array.from(decodeBase64ToBytes(secret));
    this.secretBytes = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
  }

  public async sign(method: string, url: URL, headers: Headers, body: string): Promise<void> {
    const utcNow = new Date().toUTCString();
    const contentHash = await computeContentHash(body);
    const stringToSign = `${method}\n${getUrlPathAndQuery(url)}\n${utcNow};${url.host};${contentHash}`;
    const cryptoKey = await this.getImportedKey();
    const signature = await getSubtleCrypto().sign("HMAC", cryptoKey, toCryptoBuffer(stringToSign));

    headers.set("x-ms-date", utcNow);
    headers.set("x-ms-content-sha256", contentHash);
    headers.set(
      "Authorization",
      `HMAC-SHA256 Credential=${this.id}&SignedHeaders=${signedHeaders}&Signature=${encodeBytesToBase64(signature)}`,
    );
  }

  private async getImportedKey(): Promise<CryptoKey> {
    this.importedKeyPromise ??= getSubtleCrypto().importKey(
      "raw",
      this.secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    return this.importedKeyPromise;
  }
}

function createPagedAsyncIterable<TItem, TPage extends { value: TItem[]; continuationToken?: string }>(
  fetchPage: (settings?: AppConfigurationPageSettings) => Promise<TPage>,
): PagedAsyncIterableIterator<TItem, TPage> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const page of this.byPage()) {
        for (const item of page.value) {
          yield item;
        }
      }
    },
    async *byPage(settings: AppConfigurationPageSettings = {}) {
      let continuationToken = settings.continuationToken;

      do {
        const page = await fetchPage({ continuationToken });
        yield page;
        continuationToken = page.continuationToken;
      } while (continuationToken != null);
    },
  };
}

function parseConnectionString(connectionString: string): { endpoint: string; id: string; secret: string } {
  const match = connectionStringRegex.exec(connectionString);
  if (match == null) {
    throw new Error(
      `Invalid connection string. Valid connection strings should match the regex '${connectionStringRegex.source}'.`,
    );
  }

  return {
    endpoint: normalizeEndpoint(match[1] ?? ""),
    id: match[2] ?? "",
    secret: match[3] ?? "",
  };
}

function parseConfigurationSetting(value: unknown, prefix: string | undefined): ConfigurationSetting {
  const raw = asRecord(value);
  const key = readString(raw.key);
  if (key == null) {
    throw new TypeError("App Configuration response did not include a key");
  }

  return {
    key: stripPrefix(key, prefix),
    label: readString(raw.label),
    contentType: readString(raw.content_type) ?? readString(raw.contentType),
    value: readString(raw.value),
    lastModified: readDate(raw.last_modified) ?? readDate(raw.lastModified),
    tags: readStringRecord(raw.tags),
    isReadOnly: readBoolean(raw.locked) ?? false,
    etag: readString(raw.etag),
  };
}

function parseConfigurationSettingList(
  value: unknown,
  prefix: string | undefined,
  endpoint: string,
): { value: ConfigurationSetting[]; continuationToken?: string; etag?: string } {
  const raw = asRecord(value);
  const items = Array.isArray(raw.items) ? raw.items.map((item) => parseConfigurationSetting(item, prefix)) : [];
  const nextLink = readString(raw["@nextLink"]) ?? readString(raw.nextLink);

  return {
    value: items,
    continuationToken: nextLink == null ? undefined : extractAfterTokenFromNextLink(nextLink, endpoint),
    etag: readString(raw.etag),
  };
}

function extractAfterTokenFromNextLink(nextLink: string, endpoint: string): string {
  const url = new URL(nextLink, endpoint);
  const after = url.searchParams.get("after");
  if (after == null || after.length === 0) {
    throw new Error("Invalid nextLink - invalid after token");
  }

  return after;
}

function stripPrefix(key: string, prefix: string | undefined): string {
  if (prefix == null) {
    return key;
  }

  const expectedPrefix = `${prefix}:`;
  return key.startsWith(expectedPrefix) ? key.slice(expectedPrefix.length) : key;
}

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizePrefix(prefix: string | undefined): string | undefined {
  if (prefix == null) {
    return undefined;
  }

  const normalized = prefix.trim().replace(/^:+|:+$/g, "");
  return normalized.length === 0 ? undefined : normalized;
}

function defaultKeyFilter(prefix: string | undefined): string {
  if (prefix == null) {
    return "*";
  }

  return `${escapeQueryLiteral(prefix)}:*`;
}

function escapeQueryLiteral(value: string): string {
  return value.replaceAll(reservedQueryCharacterRegex, "\\$1");
}

function buildKeyValueUrl(endpoint: string, key: string, apiVersion: string): string {
  const url = new URL(`/kv/${encodeURIComponent(key)}`, `${endpoint}/`);
  url.searchParams.set("api-version", apiVersion);
  return url.toString();
}

function buildListUrl(endpoint: string, apiVersion: string, continuationToken?: string): string {
  const url = new URL("/kv", `${endpoint}/`);
  url.searchParams.set("api-version", apiVersion);
  if (continuationToken != null) {
    url.searchParams.set("after", continuationToken);
  }

  return url.toString();
}

function createNormalizedRequestUrl(input: string, query: QueryValueMap | undefined): URL {
  const url = new URL(input);
  if (query != null) {
    for (const [name, value] of Object.entries(query)) {
      if (value == null) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(name, item);
        }
        continue;
      }

      url.searchParams.set(name, value);
    }
  }

  return normalizeQueryParameters(url);
}

function normalizeQueryParameters(url: URL): URL {
  const entries = [...url.searchParams.entries()].map(([name, value], index) => ({
    name: name.toLowerCase(),
    value,
    index,
  }));
  entries.sort((left, right) => {
    if (left.name < right.name) {
      return -1;
    }
    if (left.name > right.name) {
      return 1;
    }

    return left.index - right.index;
  });

  url.search = "";
  for (const entry of entries) {
    url.searchParams.append(entry.name, entry.value);
  }

  return url;
}

type QueryValueMap = Record<string, string | string[] | undefined>;

function createQueryParameters(input: QueryValueMap): QueryValueMap {
  return input;
}

function formatFieldsForSelect(fields: ConfigurationSettingField[] | undefined): string | undefined {
  if (fields == null) {
    return undefined;
  }

  return fields
    .map((field) => {
      switch (field) {
        case "etag":
        case "key":
        case "label":
        case "tags":
        case "value":
          return field;
        case "lastModified":
          return "last_modified";
        case "contentType":
          return "content_type";
        case "isReadOnly":
          return "locked";
        default:
          throw new TypeError("Unsupported App Configuration field");
      }
    })
    .join(",");
}

function applyAcceptDateTime(headers: Headers, acceptDateTime: Date | undefined): void {
  if (acceptDateTime != null) {
    headers.set("Accept-Datetime", acceptDateTime.toISOString());
  }
}

function isExpectedStatus(status: number): boolean {
  return status === 200 || status === 204;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return undefined;
  }

  return response.json() as Promise<unknown>;
}

async function createAppConfigurationRequestError(
  operation: string,
  response: Response,
): Promise<AppConfigurationRequestError> {
  const payload = await parseErrorResponse(response);
  const errorCode = payload?.code;
  const detailMessage = payload?.message ?? response.statusText;
  const message = `${operation} failed: ${response.status} ${detailMessage}${errorCode == null ? "" : ` (${errorCode})`}`;

  return new AppConfigurationRequestError(message, response.status, errorCode, payload?.raw);
}

async function parseErrorResponse(
  response: Response,
): Promise<{ code?: string; message?: string; raw?: unknown } | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return undefined;
  }

  try {
    const raw = (await response.json()) as unknown;
    const payload = asRecord(raw);
    return {
      code: readString(payload.name),
      message: readString(payload.detail) ?? readString(payload.title),
      raw,
    };
  } catch {
    return undefined;
  }
}

function getAppConfigurationScope(endpoint: string): string {
  const host = new URL(endpoint).host;
  if (host.endsWith("azconfig.azure.us") || host.endsWith("appconfig.azure.us")) {
    return "https://appconfig.azure.us/.default";
  }
  if (host.endsWith("azconfig.azure.cn") || host.endsWith("appconfig.azure.cn")) {
    return "https://appconfig.azure.cn/.default";
  }

  return appConfigurationOAuthScope;
}

function formatSyncTokenHeaderValue(tokens: Map<string, SyncTokenState>): string | undefined {
  if (tokens.size === 0) {
    return undefined;
  }

  return [...tokens.values()].map((token) => `${token.id}=${token.value}`).join(",");
}

function parseSyncToken(syncToken: string): SyncTokenState {
  const matches = syncTokenRegex.exec(syncToken);
  if (matches == null) {
    throw new Error(`Failed to parse sync token '${syncToken}' with regex ${syncTokenRegex.source}`);
  }

  const sequenceNumber = Number.parseInt(matches[3] ?? "", 10);
  if (Number.isNaN(sequenceNumber)) {
    throw new Error(`${syncToken}: The sequence number value '${matches[3]}' wasn't a number`);
  }

  return {
    id: matches[1] ?? "",
    value: matches[2] ?? "",
    sequenceNumber,
  };
}

async function computeContentHash(body: string): Promise<string> {
  const digest = await getSubtleCrypto().digest("SHA-256", toCryptoBuffer(body));
  return encodeBytesToBase64(digest);
}

function toCryptoBuffer(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(encodeUtf8(value));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function getSubtleCrypto(): SubtleCrypto {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto == null) {
    throw new Error("Web Crypto API is required for App Configuration signing");
  }

  return globalCrypto.subtle;
}

function getUrlPathAndQuery(url: URL): string {
  return url.search.length > 0 ? `${url.pathname}${url.search}` : url.pathname;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  return Object.fromEntries(Object.entries(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readDate(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  const entries = Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}
