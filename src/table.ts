import { DefaultAzureCredential, StorageSharedKeyCredential, getAccountNameFromUrl } from "./blob";
import { storageOAuthScope } from "./internal/request-core";
import {
  addQueryParameters,
  applyStorageDateAndVersionHeaders,
  applyTableSharedKeyLiteAuth,
  setKnownContentLength,
  storageServiceVersion,
} from "./internal/storage-request";

const xmsServiceVersion = storageServiceVersion;
const odataVersions = "3.0;NetFx";
// Azure Table service caps paged queries at 1,000 entities per request.
const maxTablePageSize = 1000;

interface TableClientOptions {
  fetch?: typeof globalThis.fetch;
}

type CredentialLike = DefaultAzureCredential | StorageSharedKeyCredential | undefined;

type OperationMode = "Merge" | "Replace";

interface TableOperationOptions {
  headers?: HeadersInit;
  body?: BodyInit | null;
  query?: Record<string, string>;
}

type TableTransactionActionType = "create" | "upsert" | "update" | "delete";

interface TableTransactionBaseAction {
  action: TableTransactionActionType;
}

export interface TableTransactionCreateAction extends TableTransactionBaseAction {
  action: "create";
  entity: TableEntity | Record<string, unknown>;
}

export interface TableTransactionDeleteAction extends TableTransactionBaseAction {
  action: "delete";
  partitionKey: string;
  rowKey: string;
}

export interface TableTransactionUpdateAction extends TableTransactionBaseAction {
  action: "update";
  entity: TableEntity | Record<string, unknown>;
}

export interface TableTransactionUpsertAction extends TableTransactionBaseAction {
  action: "upsert";
  entity: TableEntity | Record<string, unknown>;
}

export type TableTransactionAction =
  | TableTransactionCreateAction
  | TableTransactionDeleteAction
  | TableTransactionUpdateAction
  | TableTransactionUpsertAction;

export interface TableTransactionResponse {
  status: number;
  subResponses: Array<{ status: number }>;
}

interface ContinuationState {
  partitionKey: string;
  rowKey: string;
}

interface ParsedTableConnectionString {
  kind: "AccountConnString" | "SASConnString";
  url: string;
  accountName: string;
  accountKey?: string;
  accountSas?: string;
}

export interface TableCreateIfNotExistsResponse {
  succeeded: boolean;
  errorCode?: string;
}

export interface TableDeleteResponse {
  succeeded: boolean;
  errorCode?: string;
}

export interface TableEntity {
  partitionKey: string;
  rowKey: string;
  [key: string]: unknown;
}

export interface TableEntityResponse {
  readonly value: TableEntity[];
  continuationToken?: string;
  nextPartitionKey?: string;
  nextRowKey?: string;
}

export class TableServiceClient {
  public readonly accountName: string;

  public readonly url: string;

  private readonly credential: CredentialLike;

  private readonly fetcher: typeof globalThis.fetch;

  constructor(url: string, credential?: CredentialLike, options?: TableClientOptions) {
    const parsed = validateUrl(url);
    const accountName = getAccountNameFromUrl(url);

    this.url = parsed;
    this.accountName = accountName;
    this.credential = credential;
    this.fetcher = options?.fetch || globalThis.fetch;

    if (credential instanceof StorageSharedKeyCredential && accountName.length === 0) {
      throw new Error("Unable to extract accountName from provided URL for StorageSharedKeyCredential");
    }
  }

  public static fromConnectionString(connectionString: string, options?: TableClientOptions): TableServiceClient {
    const parsed = parseTableConnectionString(connectionString);
    if (parsed.kind === "AccountConnString") {
      return new TableServiceClient(
        parsed.url,
        new StorageSharedKeyCredential(parsed.accountName, parsed.accountKey || ""),
        options,
      );
    }

    const separator = parsed.url.includes("?") ? "&" : "?";
    return new TableServiceClient(`${parsed.url}${separator}${parsed.accountSas}`, undefined, options);
  }

  public getTableClient(tableName: string): TableClient {
    const tableUrl = appendToURLPath(this.url, encodeURIComponent(tableName));
    return new TableClient(tableUrl, tableName, this.credential, this.fetcher, this.url);
  }

  public async createTableIfNotExists(tableName: string): Promise<TableCreateIfNotExistsResponse> {
    const tableServiceUrl = appendToURLPath(this.url, "Tables");
    const response = await this.request("POST", tableServiceUrl, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json;odata=nometadata",
        Prefer: "return-no-content",
      },
      body: JSON.stringify({
        TableName: tableName,
      }),
    });

    if (response.status === 201 || response.status === 204) {
      return { succeeded: true };
    }

    if (response.status === 409) {
      return {
        succeeded: false,
        errorCode: "TableAlreadyExists",
      };
    }

    if (!response.ok) {
      throw new Error(`Create table failed: ${response.status} ${response.statusText}`);
    }

    return { succeeded: false };
  }

  public async deleteTableIfExists(tableName: string): Promise<TableDeleteResponse> {
    const tableUrl = buildTableResourceUrl(this.url, tableName);
    const response = await this.request("DELETE", tableUrl);

    if (response.status === 204 || response.status === 202) {
      return { succeeded: true };
    }

    if (response.status === 404) {
      return {
        succeeded: false,
        errorCode: "TableNotFound",
      };
    }

    if (!response.ok) {
      throw new Error(`Delete table failed: ${response.status} ${response.statusText}`);
    }

    return { succeeded: false };
  }

  public async request(method: string, inputUrl: string, options: TableOperationOptions = {}): Promise<Response> {
    const requestUrl = new URL(inputUrl);
    addQueryParameters(requestUrl, options.query);

    const headers = new Headers(options.headers ?? {});
    applyStorageDateAndVersionHeaders(headers, xmsServiceVersion);

    if (!headers.has("DataServiceVersion")) {
      headers.set("DataServiceVersion", odataVersions);
    }

    if (!headers.has("MaxDataServiceVersion")) {
      headers.set("MaxDataServiceVersion", odataVersions);
    }

    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json;odata=nometadata");
    }

    setKnownContentLength(headers, options.body);

    if (this.credential instanceof DefaultAzureCredential) {
      headers.set("Authorization", await this.credential.getAuthorizationHeader(storageOAuthScope));
    } else if (this.credential instanceof StorageSharedKeyCredential) {
      if (!this.accountName) {
        throw new Error("Unable to extract accountName from URL for shared key signing");
      }

      headers.set(
        "Authorization",
        await applyTableSharedKeyLiteAuth(method, requestUrl, headers, {
          accountName: this.accountName,
          accountKey: this.credential.accountKey,
        }),
      );
    }

    return this.fetcher(requestUrl.toString(), {
      method,
      headers,
      body: options.body,
    });
  }
}

export class TableClient {
  constructor(
    public readonly url: string,
    public readonly tableName: string,
    private readonly credential: CredentialLike,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly serviceUrl: string,
  ) {}

  public async createIfNotExists(): Promise<TableCreateIfNotExistsResponse> {
    const tableService = new TableServiceClient(this.serviceUrl, this.credential, { fetch: this.fetcher });
    return tableService.createTableIfNotExists(this.tableName);
  }

  public async getEntity(partitionKey: string, rowKey: string): Promise<TableEntity | undefined> {
    const response = await this.request("GET", entityUrl(this.url, partitionKey, rowKey));

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(`Get entity failed: ${response.status} ${response.statusText}`);
    }

    return parseTableEntity(await response.json());
  }

  public async upsertEntity(
    entity: TableEntity | Record<string, unknown>,
    updateMode: OperationMode = "Replace",
  ): Promise<void> {
    if (updateMode !== "Replace") {
      throw new Error(`Unsupported table upsert mode: ${updateMode}`);
    }

    const partitionKey = getPartitionKey(entity);
    const rowKey = getRowKey(entity);
    const payload = normalizeEntityPayload(entity, partitionKey, rowKey);

    const response = await this.request("PUT", entityUrl(this.url, partitionKey, rowKey), {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json;odata=nometadata",
        Prefer: "return-no-content",
        "If-Match": "*",
      },
      body: JSON.stringify(payload),
    });

    if (response.ok || response.status === 204) {
      return;
    }

    if (response.status === 404) {
      const insertResponse = await this.request("POST", this.url, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json;odata=nometadata",
          Prefer: "return-no-content",
        },
        body: JSON.stringify(payload),
      });

      if (insertResponse.ok || insertResponse.status === 204) {
        return;
      }

      throw new Error(`Upsert entity failed: ${insertResponse.status} ${insertResponse.statusText}`);
    }

    if (response.status !== 204) {
      if (response.status === 404) {
        throw new Error(`Upsert entity failed: table ${this.tableName} not found`);
      }
      throw new Error(`Upsert entity failed: ${response.status} ${response.statusText}`);
    }
  }

  public async deleteEntity(partitionKey: string, rowKey: string): Promise<TableDeleteResponse> {
    const response = await this.request("DELETE", entityUrl(this.url, partitionKey, rowKey), {
      headers: {
        "If-Match": "*",
      },
    });

    if (response.status === 404) {
      return {
        succeeded: false,
        errorCode: "ResourceNotFound",
      };
    }

    if (!response.ok) {
      throw new Error(`Delete entity failed: ${response.status} ${response.statusText}`);
    }

    return { succeeded: true };
  }

  public async deleteIfExists(): Promise<TableDeleteResponse> {
    const tableUrl = buildTableResourceUrl(this.serviceUrl, this.tableName);
    const response = await this.request("DELETE", tableUrl);

    if (response.status === 204 || response.status === 202) {
      return { succeeded: true };
    }

    if (response.status === 404) {
      return {
        succeeded: false,
        errorCode: "TableNotFound",
      };
    }

    if (!response.ok) {
      throw new Error(`Delete table failed: ${response.status} ${response.statusText}`);
    }

    return { succeeded: false };
  }

  public list(): {
    byPage: (options?: { continuationToken?: string; maxPageSize?: number }) => AsyncIterable<TableEntityResponse>;
  } {
    return {
      byPage: (options) => this.listEntitiesByPage(options),
    };
  }

  public listEntities(): {
    byPage: (options?: { continuationToken?: string; maxPageSize?: number }) => AsyncIterable<TableEntityResponse>;
  } {
    return {
      byPage: (options) => this.listEntitiesByPage(options),
    };
  }

  public async submitTransaction(actions: TableTransactionAction[]): Promise<TableTransactionResponse> {
    const subResponses: Array<{ status: number }> = [];

    for (const action of actions) {
      if (action.action === "create") {
        const partitionKey = getPartitionKey(action.entity);
        const rowKey = getRowKey(action.entity);
        const payload = normalizeEntityPayload(action.entity, partitionKey, rowKey);

        const response = await this.request("POST", this.url, {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json;odata=nometadata",
            Prefer: "return-no-content",
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(`Table transaction create failed: ${response.status} ${response.statusText}`);
        }

        subResponses.push({ status: response.status });
        continue;
      }

      if (action.action === "update" || action.action === "upsert") {
        const partitionKey = getPartitionKey(action.entity);
        const rowKey = getRowKey(action.entity);
        const payload = normalizeEntityPayload(action.entity, partitionKey, rowKey);

        const response = await this.request("PUT", entityUrl(this.url, partitionKey, rowKey), {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json;odata=nometadata",
            Prefer: "return-no-content",
            "If-Match": "*",
          },
          body: JSON.stringify(payload),
        });

        if (response.ok || response.status === 204) {
          subResponses.push({ status: response.status });
          continue;
        }

        if (action.action === "update") {
          throw new Error(`Table transaction update failed: ${response.status} ${response.statusText}`);
        }

        if (response.status !== 404) {
          throw new Error(`Table transaction upsert failed: ${response.status} ${response.statusText}`);
        }

        const insertResponse = await this.request("POST", this.url, {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json;odata=nometadata",
            Prefer: "return-no-content",
          },
          body: JSON.stringify(payload),
        });

        if (!insertResponse.ok && insertResponse.status !== 204) {
          throw new Error(`Table transaction upsert failed: ${insertResponse.status} ${insertResponse.statusText}`);
        }

        subResponses.push({ status: insertResponse.status });
        continue;
      }

      if (action.action === "delete") {
        const response = await this.request("DELETE", entityUrl(this.url, action.partitionKey, action.rowKey), {
          headers: {
            "If-Match": "*",
          },
        });

        if (!response.ok) {
          throw new Error(`Table transaction delete failed: ${response.status} ${response.statusText}`);
        }

        subResponses.push({ status: response.status });
        continue;
      }

      throw new Error(`Unsupported table transaction action: ${action.action}`);
    }

    return {
      status: actions.length > 0 ? 202 : 204,
      subResponses,
    };
  }

  private async *listEntitiesByPage(options?: {
    continuationToken?: string;
    maxPageSize?: number;
  }): AsyncGenerator<TableEntityResponse> {
    let continuationToken = options?.continuationToken;
    const maxPageSize = options?.maxPageSize;

    while (true) {
      const query: Record<string, string> = {};
      if (maxPageSize != null) {
        query["$top"] = String(Math.min(maxPageSize, maxTablePageSize));
      }

      const continuationState = parseContinuationToken(continuationToken);
      if (continuationState != null) {
        query.NextPartitionKey = continuationState.partitionKey;
        query.NextRowKey = continuationState.rowKey;
      }

      const response = await this.request("GET", `${this.url}()`, { query });
      if (!response.ok) {
        throw new Error(`List entities failed: ${response.status} ${response.statusText}`);
      }

      const bodyText = await response.text();
      const listResponse = parseListEntitiesResponse(bodyText);

      const nextPartitionKey = response.headers.get("x-ms-continuation-NextPartitionKey");
      const nextRowKey = response.headers.get("x-ms-continuation-NextRowKey");
      const hasNext =
        nextPartitionKey != null && nextPartitionKey.length > 0 && nextRowKey != null && nextRowKey.length > 0;
      const nextContinuationToken = hasNext
        ? encodeContinuationToken({ partitionKey: nextPartitionKey, rowKey: nextRowKey })
        : undefined;

      yield {
        value: listResponse,
        continuationToken: nextContinuationToken,
        nextPartitionKey,
        nextRowKey,
      };

      if (!hasNext) {
        break;
      }

      continuationToken = nextContinuationToken;
    }
  }

  private async request(method: string, targetUrl: string, options: TableOperationOptions = {}): Promise<Response> {
    const tableService = new TableServiceClient(this.serviceUrl, this.credential, { fetch: this.fetcher });
    const headers = new Headers(options.headers ?? {});
    if (options.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await tableService.request(method, targetUrl, {
      ...options,
      headers,
    });

    return response;
  }
}

function validateUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
    return new URL(`${parsed.origin}${parsed.pathname.slice(0, -1)}`).toString();
  }

  return parsed.toString();
}

function parseTableConnectionString(connectionString: string): ParsedTableConnectionString {
  const parts = Object.fromEntries(
    connectionString
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => {
        const separatorIndex = part.indexOf("=");

        if (separatorIndex < 0) {
          return [part, ""] as const;
        }

        const key = part.slice(0, separatorIndex);
        const value = part.slice(separatorIndex + 1);
        return [key, value] as const;
      }),
  ) as Record<string, string>;

  const tableEndpoint = parts.TableEndpoint?.replace(/\/$/, "");
  const accountKey = parts.AccountKey;
  const defaultProtocol = parts.DefaultEndpointsProtocol?.toLowerCase();
  const endpointSuffix = parts.EndpointSuffix;
  const accountSas = parts.SharedAccessSignature;
  const accountName = parts.AccountName || (tableEndpoint ? getAccountNameFromUrl(tableEndpoint) : "");

  if (defaultProtocol != null && accountKey != null) {
    const protocol = defaultProtocol;
    if (protocol !== "https" && protocol !== "http") {
      throw new Error(
        "Invalid DefaultEndpointsProtocol in the provided Connection String. Expecting 'https' or 'http'",
      );
    }

    if (!endpointSuffix && !tableEndpoint) {
      throw new Error("Invalid EndpointSuffix in the provided Connection String");
    }

    const endpoint = tableEndpoint || `${protocol}://${accountName}.table.${endpointSuffix}`;
    if (!endpoint) {
      throw new Error("Invalid TableEndpoint in the provided Connection String");
    }

    if (!accountName) {
      throw new Error("Invalid AccountName in the provided Connection String");
    }

    if (decodeBase64ToBytes(accountKey).byteLength === 0) {
      throw new Error("Invalid AccountKey in the provided Connection String");
    }

    return {
      kind: "AccountConnString",
      url: endpoint,
      accountName,
      accountKey,
    };
  }

  if (accountSas != null) {
    if (!tableEndpoint) {
      throw new Error("Invalid TableEndpoint in the provided SAS Connection String");
    }

    if (!accountName) {
      throw new Error("Invalid AccountName in the provided SAS Connection String");
    }

    return {
      kind: "SASConnString",
      url: tableEndpoint,
      accountName,
      accountSas: accountSas.replace(/^\?/, ""),
    };
  }

  throw new Error("Connection string must be either an Account connection string or a SAS connection string");
}

function appendToURLPath(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = basePath + "/" + path;
  return url.toString().replace(/\/$/, "");
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  if (typeof globalThis.atob !== "function") {
    throw new Error("atob is required to decode shared key values");
  }

  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function entityUrl(serviceUrl: string, partitionKey: string, rowKey: string): string {
  const encodedPartitionKey = encodeURIComponent(partitionKey.replaceAll("'", "''"));
  const encodedRowKey = encodeURIComponent(rowKey.replaceAll("'", "''"));
  const entityPath = `(PartitionKey='${encodedPartitionKey}',RowKey='${encodedRowKey}')`;
  return `${serviceUrl.replace(/\/$/, "")}${entityPath}`;
}

function buildTableResourceUrl(serviceUrl: string, tableName: string): string {
  const encodedName = encodeURIComponent(tableName.replaceAll("'", "''"));
  return `${serviceUrl.replace(/\/$/, "")}/Tables('${encodedName}')`;
}

function getPartitionKey(entity: TableEntity | Record<string, unknown>): string {
  if (typeof entity.partitionKey === "string") {
    return entity.partitionKey;
  }

  if (typeof entity.PartitionKey === "string") {
    return entity.PartitionKey;
  }

  throw new Error("Entity is missing PartitionKey/partitionKey");
}

function getRowKey(entity: TableEntity | Record<string, unknown>): string {
  if (typeof entity.rowKey === "string") {
    return entity.rowKey;
  }

  if (typeof entity.RowKey === "string") {
    return entity.RowKey;
  }

  throw new Error("Entity is missing RowKey/rowKey");
}

function normalizeEntityPayload(
  entity: TableEntity | Record<string, unknown>,
  partitionKey: string,
  rowKey: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(entity)) {
    if (name === "partitionKey" || name === "rowKey") {
      continue;
    }

    if (value !== undefined) {
      payload[name] = value;
    }
  }

  payload.PartitionKey = partitionKey;
  payload.RowKey = rowKey;

  return payload;
}

function parseTableEntity(rawEntity: unknown): TableEntity {
  if (rawEntity == null || typeof rawEntity !== "object") {
    throw new Error("Invalid table entity response");
  }

  const partitionKeyRaw = (rawEntity as { [key: string]: unknown }).PartitionKey;
  const rowKeyRaw = (rawEntity as { [key: string]: unknown }).RowKey;

  if (typeof partitionKeyRaw !== "string" || typeof rowKeyRaw !== "string") {
    throw new Error("Invalid table entity response");
  }

  const entity: TableEntity = {
    partitionKey: partitionKeyRaw,
    rowKey: rowKeyRaw,
  };

  for (const [name, value] of Object.entries(rawEntity as { [key: string]: unknown })) {
    entity[name] = value;
  }

  return entity;
}

function parseListEntitiesResponse(text: string): TableEntity[] {
  if (text.length === 0) {
    return [];
  }

  const body = JSON.parse(text) as { value?: unknown };

  if (body == null || typeof body !== "object") {
    return [];
  }

  const entities = body.value;
  if (!Array.isArray(entities)) {
    return [];
  }

  const parsed: TableEntity[] = [];
  for (const entity of entities) {
    if (typeof entity !== "object" || entity == null) {
      continue;
    }

    const candidate = entity as { [key: string]: unknown };
    if (typeof candidate.PartitionKey !== "string" || typeof candidate.RowKey !== "string") {
      continue;
    }

    parsed.push(parseTableEntity(candidate));
  }

  return parsed;
}

function encodeContinuationToken(state: ContinuationState): string {
  const params = new URLSearchParams();
  params.set("NextPartitionKey", state.partitionKey);
  params.set("NextRowKey", state.rowKey);
  return params.toString();
}

function parseContinuationToken(token: string | undefined): ContinuationState | undefined {
  if (!token) {
    return undefined;
  }

  const params = new URLSearchParams(token);
  const partitionKey = params.get("NextPartitionKey");
  const rowKey = params.get("NextRowKey");

  if (partitionKey == null || rowKey == null) {
    return undefined;
  }

  return { partitionKey, rowKey };
}
