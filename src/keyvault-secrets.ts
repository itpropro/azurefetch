import { AzureFetchError } from "./errors";
import { keyVaultOAuthScope, type AzureRequestCredential } from "./internal/request-core";
import {
  parseDeletedKeyVaultSecret,
  parseKeyVaultSecret,
  parseSecretList,
  parseSecretProperties,
} from "./internal/keyvault-secret";
import { AzureClient, type AzureRequestInit, type AzureRequestOverrides } from "./client";

const keyVaultApiVersion = "7.6";

export interface KeyVaultClientOptions extends AzureRequestOverrides {
  fetch?: typeof globalThis.fetch;
}

export type KeyVaultRequestOptions = Omit<AzureRequestInit, "method" | "body">;

interface SecretAttributesOptions extends KeyVaultRequestOptions {
  contentType?: string;
  enabled?: boolean;
  notBefore?: Date;
  expiresOn?: Date;
  tags?: Record<string, string>;
}

export interface SecretProperties {
  vaultUrl: string;
  name: string;
  version?: string;
  id?: string;
  contentType?: string;
  enabled?: boolean;
  notBefore?: Date;
  expiresOn?: Date;
  tags?: Record<string, string>;
  certificateKeyId?: string;
  managed?: boolean;
  createdOn?: Date;
  updatedOn?: Date;
  recoveryLevel?: string;
  recoverableDays?: number;
  recoveryId?: string;
  scheduledPurgeDate?: Date;
  deletedOn?: Date;
}

export interface KeyVaultSecret {
  name: string;
  value?: string;
  properties: SecretProperties;
}

export interface DeletedSecret extends KeyVaultSecret {
  recoveryId?: string;
  scheduledPurgeDate?: Date;
  deletedOn?: Date;
}

export interface GetSecretOptions extends KeyVaultRequestOptions {
  version?: string;
}

export interface SetSecretOptions extends SecretAttributesOptions {}

export interface UpdateSecretPropertiesOptions extends SecretAttributesOptions {}

export interface ListPropertiesOptions extends KeyVaultRequestOptions {}

export interface KeyVaultPageSettings {
  continuationToken?: string;
  maxPageSize?: number;
}

export interface SecretPropertiesPage {
  response: Response;
  value: SecretProperties[];
  continuationToken?: string;
}

export interface DeletedSecretPage {
  response: Response;
  value: DeletedSecret[];
  continuationToken?: string;
}

export interface PagedAsyncIterableIterator<T, TPage> extends AsyncIterable<T> {
  byPage(settings?: KeyVaultPageSettings): AsyncIterable<TPage>;
}

export class KeyVaultRequestError extends AzureFetchError {
  public override readonly name = "KeyVaultRequestError";

  constructor(
    message: string,
    public readonly status: number,
    public readonly errorCode?: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export class KeyVaultSecretClient {
  public readonly url: string;

  private readonly client: AzureClient;

  constructor(vaultUrl: string, credential?: AzureRequestCredential, options?: KeyVaultClientOptions) {
    this.url = normalizeVaultUrl(vaultUrl);
    this.client = new AzureClient({
      credential,
      fetch: options?.fetch,
      scope: options?.scope ?? keyVaultOAuthScope,
      authorityHost: options?.authorityHost,
    });
  }

  public async setSecret(name: string, value: string, options: SetSecretOptions = {}): Promise<KeyVaultSecret> {
    assertSecretName(name);

    const response = await this.requestJson("PUT", buildSecretPath(this.url, name), {
      ...options,
      body: JSON.stringify({
        value,
        contentType: options.contentType,
        tags: options.tags,
        attributes: serializeSecretAttributes(options),
      }),
    });

    return parseKeyVaultSecret(await parseJsonResponse(response), this.url, name);
  }

  public async getSecret(name: string, options: GetSecretOptions = {}): Promise<KeyVaultSecret> {
    assertSecretName(name);

    const response = await this.request("GET", buildSecretVersionPath(this.url, name, options.version ?? ""), options);
    return parseKeyVaultSecret(await parseJsonResponse(response), this.url, name);
  }

  public async updateSecretProperties(
    name: string,
    version = "",
    options: UpdateSecretPropertiesOptions = {},
  ): Promise<SecretProperties> {
    assertSecretName(name);

    const response = await this.requestJson("PATCH", buildSecretVersionPath(this.url, name, version), {
      ...options,
      body: JSON.stringify({
        contentType: options.contentType,
        tags: options.tags,
        attributes: serializeSecretAttributes(options),
      }),
    });

    return parseSecretProperties(await parseJsonResponse(response), this.url, name);
  }

  public async deleteSecret(name: string, options: KeyVaultRequestOptions = {}): Promise<DeletedSecret> {
    assertSecretName(name);

    const response = await this.request("DELETE", buildSecretPath(this.url, name), options);
    return parseDeletedKeyVaultSecret(await parseJsonResponse(response), this.url, name);
  }

  public async getDeletedSecret(name: string, options: KeyVaultRequestOptions = {}): Promise<DeletedSecret> {
    assertSecretName(name);

    const response = await this.request("GET", buildDeletedSecretPath(this.url, name), options);
    return parseDeletedKeyVaultSecret(await parseJsonResponse(response), this.url, name);
  }

  public async purgeDeletedSecret(name: string, options: KeyVaultRequestOptions = {}): Promise<void> {
    assertSecretName(name);

    await this.request("DELETE", buildDeletedSecretPath(this.url, name), options, [204]);
  }

  public async recoverDeletedSecret(name: string, options: KeyVaultRequestOptions = {}): Promise<KeyVaultSecret> {
    assertSecretName(name);

    const response = await this.request("POST", buildRecoverDeletedSecretPath(this.url, name), options);
    return parseKeyVaultSecret(await parseJsonResponse(response), this.url, name);
  }

  public listPropertiesOfSecrets(
    options: ListPropertiesOptions = {},
  ): PagedAsyncIterableIterator<SecretProperties, SecretPropertiesPage> {
    return createPagedAsyncIterable(async (settings) => this.fetchSecretPropertiesPage("/secrets", options, settings));
  }

  public listDeletedSecrets(
    options: ListPropertiesOptions = {},
  ): PagedAsyncIterableIterator<DeletedSecret, DeletedSecretPage> {
    return createPagedAsyncIterable(async (settings) => this.fetchDeletedSecretsPage(options, settings));
  }

  public listPropertiesOfSecretVersions(
    name: string,
    options: ListPropertiesOptions = {},
  ): PagedAsyncIterableIterator<SecretProperties, SecretPropertiesPage> {
    assertSecretName(name);

    return createPagedAsyncIterable(async (settings) =>
      this.fetchSecretPropertiesPage(`/secrets/${encodeURIComponent(name)}/versions`, options, settings, name),
    );
  }

  private async fetchSecretPropertiesPage(
    path: string,
    options: ListPropertiesOptions,
    settings: KeyVaultPageSettings | undefined,
    secretName?: string,
  ): Promise<SecretPropertiesPage> {
    const response = await this.requestPage(path, options, settings);
    const payload = parseSecretList(await parseJsonResponse(response), (item) =>
      parseSecretProperties(item, this.url, secretName),
    );

    return {
      response,
      value: payload.value,
      continuationToken: payload.continuationToken,
    };
  }

  private async fetchDeletedSecretsPage(
    options: ListPropertiesOptions,
    settings: KeyVaultPageSettings | undefined,
  ): Promise<DeletedSecretPage> {
    const response = await this.requestPage("/deletedsecrets", options, settings);
    const payload = parseSecretList(await parseJsonResponse(response), (item) =>
      parseDeletedKeyVaultSecret(item, this.url),
    );

    return {
      response,
      value: payload.value,
      continuationToken: payload.continuationToken,
    };
  }

  private async requestPage(
    path: string,
    options: ListPropertiesOptions,
    settings: KeyVaultPageSettings | undefined,
  ): Promise<Response> {
    const requestUrl = buildPageUrl(this.url, path, settings);
    return this.request("GET", requestUrl, options);
  }

  private async requestJson(
    method: string,
    input: string,
    options: KeyVaultRequestOptions & { body: string },
    expectedStatuses: number[] = [200],
  ): Promise<Response> {
    const headers = new Headers(options.headers ?? {});
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    return this.request(method, input, { ...options, headers }, expectedStatuses);
  }

  private async request(
    method: string,
    input: string,
    options: KeyVaultRequestOptions = {},
    expectedStatuses: number[] = [200],
  ): Promise<Response> {
    const headers = new Headers(options.headers ?? {});
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }

    const requestUrl = appendApiVersion(input);
    const response = await this.client.fetch(requestUrl, {
      ...options,
      method,
      headers,
    });

    if (!expectedStatuses.includes(response.status)) {
      throw await createKeyVaultRequestError(`${method} ${requestUrl}`, response);
    }

    return response;
  }
}

function createPagedAsyncIterable<TItem, TPage extends { value: TItem[]; continuationToken?: string }>(
  fetchPage: (settings?: KeyVaultPageSettings) => Promise<TPage>,
): PagedAsyncIterableIterator<TItem, TPage> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const page of this.byPage()) {
        for (const item of page.value) {
          yield item;
        }
      }
    },
    async *byPage(settings: KeyVaultPageSettings = {}) {
      let continuationToken = settings.continuationToken;

      do {
        const page = await fetchPage({
          ...settings,
          continuationToken,
        });
        yield page;
        continuationToken = page.continuationToken;
      } while (continuationToken != null);
    },
  };
}

function buildSecretPath(vaultUrl: string, name: string): string {
  return `${vaultUrl}/secrets/${encodeURIComponent(name)}`;
}

function buildSecretVersionPath(vaultUrl: string, name: string, version: string): string {
  return `${buildSecretPath(vaultUrl, name)}/${encodeURIComponent(version)}`;
}

function buildDeletedSecretPath(vaultUrl: string, name: string): string {
  return `${vaultUrl}/deletedsecrets/${encodeURIComponent(name)}`;
}

function buildRecoverDeletedSecretPath(vaultUrl: string, name: string): string {
  return `${buildDeletedSecretPath(vaultUrl, name)}/recover`;
}

function buildPageUrl(vaultUrl: string, path: string, settings: KeyVaultPageSettings | undefined): string {
  const requestUrl =
    settings?.continuationToken == null ? new URL(path, `${vaultUrl}/`) : new URL(settings.continuationToken);
  const normalizedPageSize = normalizeMaxPageSize(settings?.maxPageSize);

  if (normalizedPageSize != null) {
    requestUrl.searchParams.set("maxresults", String(normalizedPageSize));
  }

  return requestUrl.toString();
}

function normalizeVaultUrl(vaultUrl: string): string {
  const url = new URL(vaultUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function appendApiVersion(url: string): string {
  const requestUrl = new URL(url);
  if (!requestUrl.searchParams.has("api-version")) {
    requestUrl.searchParams.set("api-version", keyVaultApiVersion);
  }

  return requestUrl.toString();
}

function assertSecretName(name: string): void {
  if (name.trim().length === 0) {
    throw new TypeError("Secret name must be a non-empty string");
  }
}

function serializeSecretAttributes(options: SecretAttributesOptions): Record<string, boolean | number> | undefined {
  const attributes: Record<string, boolean | number> = {};

  if (options.enabled !== undefined) {
    attributes.enabled = options.enabled;
  }

  const notBefore = serializeDate(options.notBefore);
  if (notBefore !== undefined) {
    attributes.nbf = notBefore;
  }

  const expiresOn = serializeDate(options.expiresOn);
  if (expiresOn !== undefined) {
    attributes.exp = expiresOn;
  }

  if (Object.keys(attributes).length === 0) {
    return undefined;
  }

  return attributes;
}

function serializeDate(value: Date | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }

  return Math.floor(value.getTime() / 1000);
}

function normalizeMaxPageSize(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

async function createKeyVaultRequestError(operation: string, response: Response): Promise<KeyVaultRequestError> {
  const payload = await parseErrorResponse(response);
  const errorCode = payload?.code;
  const detailMessage = payload?.message ?? response.statusText;
  const message = `${operation} failed: ${response.status} ${detailMessage}${errorCode == null ? "" : ` (${errorCode})`}`;

  return new KeyVaultRequestError(message, response.status, errorCode, payload?.raw);
}

async function parseErrorResponse(
  response: Response,
): Promise<{ code?: string; message?: string; raw?: unknown } | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined;
  }

  try {
    const raw = (await response.json()) as unknown;
    if (!isRecord(raw)) {
      return { raw };
    }

    const error = isRecord(raw.error) ? raw.error : raw;
    return {
      code: typeof error.code === "string" ? error.code : undefined,
      message: typeof error.message === "string" ? error.message : undefined,
      raw,
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
