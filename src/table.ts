import { StorageSharedKeyCredential } from "./storage-shared-key-credential";
import { encodeContinuationToken, parseContinuationToken } from "./internal/continuation-token";
import { storageOAuthScope } from "./internal/request-core";
import {
  addQueryParameters,
  applyStorageDateAndVersionHeaders,
  applyTableSharedKeyLiteAuth,
  setKnownContentLength,
  storageServiceVersion,
} from "./internal/storage-request";
import { getAccountNameFromUrl } from "./internal/storage-url";
import {
  getPartitionKey,
  getRowKey,
  normalizeEntityPayload,
  parseTableEntity,
  parseTableEntityList,
  type ParsedTableEntity,
} from "./internal/table-entity";

const xmsServiceVersion = storageServiceVersion;
const odataVersions = "3.0;NetFx";
// Azure Table service caps paged queries at 1,000 entities per request.
const maxTablePageSize = 1000;

interface TableClientOptions {
  fetch?: typeof globalThis.fetch;
}

interface AuthorizationCredential {
  getAuthorizationHeader(scopes?: string | string[]): Promise<string>;
}

type CredentialLike = AuthorizationCredential | StorageSharedKeyCredential | undefined;

type OperationMode = "Replace";

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

export interface TableEntity extends ParsedTableEntity {}

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
    this.fetcher = options?.fetch ?? globalThis.fetch;

    if (credential instanceof StorageSharedKeyCredential && accountName.length === 0) {
      throw new Error("Unable to extract accountName from provided URL for StorageSharedKeyCredential");
    }
  }

  public static fromConnectionString(connectionString: string, options?: TableClientOptions): TableServiceClient {
    const parsed = parseTableConnectionString(connectionString);
    if (parsed.kind === "AccountConnString") {
      const accountKey = parsed.accountKey;
      if (accountKey == null) {
        throw new Error("Invalid AccountKey in the provided Connection String");
      }

      return new TableServiceClient(
        parsed.url,
        new StorageSharedKeyCredential(parsed.accountName, accountKey),
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

    if (hasAuthorizationCredential(this.credential)) {
      headers.set("Authorization", await this.credential.getAuthorizationHeader(storageOAuthScope));
    } else if (this.credential instanceof StorageSharedKeyCredential) {
      if (!this.accountName) {
        throw new Error("Unable to extract accountName from URL for shared key signing");
      }

      headers.set("Authorization", await applyTableSharedKeyLiteAuth(method, requestUrl, headers, this.credential));
    }

    return this.fetcher(requestUrl.toString(), {
      method,
      headers,
      body: options.body,
    });
  }
}

export class TableClient {
  private readonly service: TableServiceClient;

  constructor(
    public readonly url: string,
    public readonly tableName: string,
    private readonly credential: CredentialLike,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly serviceUrl: string,
  ) {
    this.service = new TableServiceClient(serviceUrl, credential, { fetch: fetcher });
  }

  public async createIfNotExists(): Promise<TableCreateIfNotExistsResponse> {
    return this.service.createTableIfNotExists(this.tableName);
  }

  public async getEntity(partitionKey: string, rowKey: string): Promise<TableEntity | undefined> {
    const response = await this.request("GET", entityUrl(this.url, partitionKey, rowKey));

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(`Get entity failed: ${response.status} ${response.statusText}`);
    }

    return parseTableEntity(parseJson(await response.text()));
  }

  public async upsertEntity(
    entity: TableEntity | Record<string, unknown>,
    _updateMode: OperationMode = "Replace",
  ): Promise<void> {
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
    return this.listEntities();
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
      switch (action.action) {
        case "create": {
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
          break;
        }

        case "update":
        case "upsert": {
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
            break;
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
          break;
        }

        case "delete": {
          const response = await this.request("DELETE", entityUrl(this.url, action.partitionKey, action.rowKey), {
            headers: {
              "If-Match": "*",
            },
          });

          if (!response.ok) {
            throw new Error(`Table transaction delete failed: ${response.status} ${response.statusText}`);
          }

          subResponses.push({ status: response.status });
          break;
        }

        default: {
          throw new Error(`Unsupported table transaction action: ${action.action}`);
        }
      }
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
    let hasMore = true;

    while (hasMore) {
      const query: Record<string, string> = {};
      if (maxPageSize != null) {
        query.$top = String(Math.min(maxPageSize, maxTablePageSize));
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

      const listResponse = parseTableEntityList(await response.text());

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
        hasMore = false;
        continue;
      }

      continuationToken = nextContinuationToken;
    }
  }

  private async request(method: string, targetUrl: string, options: TableOperationOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers ?? {});
    if (options.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await this.service.request(method, targetUrl, {
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
  const accountNameFromEndpoint = tableEndpoint == null ? undefined : getAccountNameFromUrl(tableEndpoint);
  const accountName =
    parts.AccountName == null || parts.AccountName.length === 0 ? accountNameFromEndpoint : parts.AccountName;

  if (defaultProtocol != null && accountKey != null) {
    const protocol = defaultProtocol;
    if (protocol !== "https" && protocol !== "http") {
      throw new Error(
        "Invalid DefaultEndpointsProtocol in the provided Connection String. Expecting 'https' or 'http'",
      );
    }

    if ((endpointSuffix == null || endpointSuffix.length === 0) && tableEndpoint == null) {
      throw new Error("Invalid EndpointSuffix in the provided Connection String");
    }

    const endpoint = tableEndpoint ?? `${protocol}://${accountName}.table.${endpointSuffix}`;
    if (endpoint.length === 0) {
      throw new Error("Invalid TableEndpoint in the provided Connection String");
    }

    if (accountName == null || accountName.length === 0) {
      throw new Error("Invalid AccountName in the provided Connection String");
    }

    if (accountKey.length === 0) {
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
    if (tableEndpoint == null || tableEndpoint.length === 0) {
      throw new Error("Invalid TableEndpoint in the provided SAS Connection String");
    }

    if (accountName == null || accountName.length === 0) {
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

function hasAuthorizationCredential(credential: CredentialLike): credential is AuthorizationCredential {
  return credential != null && typeof credential.getAuthorizationHeader === "function";
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}
