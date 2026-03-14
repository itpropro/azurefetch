import { createHmac } from "node:crypto";

import { DefaultAzureCredential } from "./default-azure-credential";
import { storageOAuthScope } from "./internal/request-core";
import {
  applyBlobSharedKeyAuth,
  addQueryParameters,
  applyStorageDateAndVersionHeaders,
  setKnownContentLength,
  storageServiceVersion,
} from "./internal/storage-request";

interface BlobClientOptions {
  fetch?: typeof globalThis.fetch;
}

type CredentialLike = DefaultAzureCredential | StorageSharedKeyCredential | undefined;

interface BlobOperationOptions {
  headers?: HeadersInit;
  body?: BodyInit | null;
}

interface QueryOptions {
  continuationToken?: string;
  maxPageSize?: number;
}

export interface BlobItem {
  name: string;
  metadata?: Record<string, string>;
}

export interface ListBlobsFlatSegment {
  segment: {
    blobItems: BlobItem[];
  };
  continuationToken?: string;
  nextMarker?: string;
}

export interface BlobGetPropertiesResponse {
  etag?: string;
  lastModified?: Date;
  lastAccessed?: Date;
  createdOn?: Date;
  metadata: Record<string, string>;
}

const batchMaxRequestCount = 256;
const multipartLineEnding = "\r\n";
const xmsServiceVersion = storageServiceVersion;
// Azure Blob service pages at most 5,000 items for list operations.
const maxBlobPageSize = 5000;

export interface BlobBatchSubResponse {
  status: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  bodyAsText?: string;
  errorCode?: string;
  _request?: BlobBatchSubRequest;
}

export interface BlobBatchSubmitResponse {
  status: number;
  subResponses: Array<BlobBatchSubResponse | undefined>;
  subResponsesSucceededCount: number;
  subResponsesFailedCount: number;
  contentType?: string;
  requestId?: string;
  errorCode?: string;
}

export interface BlobBatchDeleteBlobOptions {
  deleteSnapshots?: "include" | "only";
}

interface BlobBatchSubRequest {
  method: string;
  uri: string;
  url: string;
  credential?: CredentialLike;
  headers: Record<string, string>;
}

export interface ContainerItem {
  name: string;
}

export interface ListContainersSegment {
  segment: {
    containerItems: ContainerItem[];
  };
  continuationToken?: string;
  nextMarker?: string;
}

export interface BlobDeleteIfExistsResponse {
  succeeded: boolean;
  errorCode?: string;
}

export interface ContainerCreateIfNotExistsResponse {
  succeeded: boolean;
}

export { DefaultAzureCredential } from "./default-azure-credential";

export class StorageSharedKeyCredential {
  public readonly accountKey: string;
  private readonly accountKeyBytes: Buffer;

  constructor(
    public readonly accountName: string,
    accountKey: string,
  ) {
    if (accountName.length === 0) {
      throw new TypeError("accountName is required");
    }

    if (accountKey.length === 0) {
      throw new TypeError("accountKey is required");
    }

    this.accountKey = accountKey;
    this.accountKeyBytes = Buffer.from(accountKey, "base64");
  }

  public computeHMACSHA256(stringToSign: string): string {
    return createHmac("sha256", this.accountKeyBytes).update(stringToSign, "utf8").digest("base64");
  }
}

export class AccountSASPermissions {
  public read = false;
  public write = false;
  public delete = false;
  public deleteVersion = false;
  public list = false;
  public add = false;
  public create = false;
  public update = false;
  public process = false;
  public tag = false;
  public filter = false;
  public setImmutabilityPolicy = false;
  public permanentDelete = false;

  public static parse(permissions: string): AccountSASPermissions {
    const accountSASPermissions = new AccountSASPermissions();

    for (const character of permissions) {
      switch (character) {
        case "r":
          accountSASPermissions.read = true;
          break;
        case "w":
          accountSASPermissions.write = true;
          break;
        case "d":
          accountSASPermissions.delete = true;
          break;
        case "x":
          accountSASPermissions.deleteVersion = true;
          break;
        case "l":
          accountSASPermissions.list = true;
          break;
        case "a":
          accountSASPermissions.add = true;
          break;
        case "c":
          accountSASPermissions.create = true;
          break;
        case "u":
          accountSASPermissions.update = true;
          break;
        case "p":
          accountSASPermissions.process = true;
          break;
        case "t":
          accountSASPermissions.tag = true;
          break;
        case "f":
          accountSASPermissions.filter = true;
          break;
        case "i":
          accountSASPermissions.setImmutabilityPolicy = true;
          break;
        case "y":
          accountSASPermissions.permanentDelete = true;
          break;
        default:
          throw new RangeError(`Invalid permission character: ${character}`);
      }
    }

    return accountSASPermissions;
  }

  public toString(): string {
    const permissions: string[] = [];
    if (this.read) {
      permissions.push("r");
    }
    if (this.write) {
      permissions.push("w");
    }
    if (this.delete) {
      permissions.push("d");
    }
    if (this.deleteVersion) {
      permissions.push("x");
    }
    if (this.filter) {
      permissions.push("f");
    }
    if (this.tag) {
      permissions.push("t");
    }
    if (this.list) {
      permissions.push("l");
    }
    if (this.add) {
      permissions.push("a");
    }
    if (this.create) {
      permissions.push("c");
    }
    if (this.update) {
      permissions.push("u");
    }
    if (this.process) {
      permissions.push("p");
    }
    if (this.setImmutabilityPolicy) {
      permissions.push("i");
    }
    if (this.permanentDelete) {
      permissions.push("y");
    }

    return permissions.join("");
  }
}

export interface ParsedConnectionString {
  kind: "AccountConnString" | "SASConnString";
  url: string;
  accountName: string;
  accountKey?: string;
  accountSas?: string;
}

export interface BlobServiceClientOptions extends BlobClientOptions {}

export class BlobServiceClient {
  public readonly accountName: string;

  public readonly url: string;

  private readonly credential: CredentialLike;

  private readonly fetcher: typeof globalThis.fetch;

  constructor(url: string, credential?: CredentialLike, options?: BlobServiceClientOptions) {
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

  public static fromConnectionString(connectionString: string, options?: BlobClientOptions): BlobServiceClient {
    const parsed = parseConnectionString(connectionString);
    if (parsed.kind === "AccountConnString") {
      return new BlobServiceClient(
        parsed.url,
        new StorageSharedKeyCredential(parsed.accountName, parsed.accountKey || ""),
        options,
      );
    }

    const separator = parsed.url.includes("?") ? "&" : "?";
    return new BlobServiceClient(`${parsed.url}${separator}${parsed.accountSas}`, undefined, options);
  }

  public getContainerClient(containerName: string): ContainerClient {
    const containerUrl = appendToURLPath(this.url, encodeURIComponent(containerName));
    return new ContainerClient(containerUrl, this.credential, this.fetcher);
  }

  public getBlobBatchClient(): BlobBatchClient {
    return new BlobBatchClient(this.url, this.credential, this.fetcher);
  }

  public listContainers(): {
    byPage: (options?: QueryOptions) => AsyncIterable<ListContainersSegment>;
  } {
    return {
      byPage: (options) => this.listContainersByPage(options),
    };
  }

  public generateAccountSasUrl(
    expiresOn = new Date(Date.now() + 60 * 60 * 1000),
    options?: {
      permissions?: string;
      services?: string;
      resourceTypes?: string;
      protocol?: string;
    },
  ): string {
    const permissions = options?.permissions ?? "";
    const services = options?.services ?? "b";
    const resourceTypes = options?.resourceTypes ?? "sco";
    const protocol = options?.protocol ?? "https";
    const expiry = expiresOn.toISOString();

    const signedUrl = new URL(this.url);
    signedUrl.searchParams.set("sp", permissions);
    signedUrl.searchParams.set("ss", services);
    signedUrl.searchParams.set("srt", resourceTypes);
    signedUrl.searchParams.set("sv", xmsServiceVersion);
    signedUrl.searchParams.set("se", expiry);
    signedUrl.searchParams.set("spr", protocol);

    return signedUrl.toString();
  }

  public async request(
    method: string,
    inputUrl: string,
    options: BlobOperationOptions & { query?: Record<string, string> } = {},
  ): Promise<Response> {
    const url = new URL(inputUrl);
    addQueryParameters(url, options.query);

    const headers = new Headers(options.headers ?? {});
    applyStorageDateAndVersionHeaders(headers);
    setKnownContentLength(headers, options.body);

    if (this.credential instanceof DefaultAzureCredential) {
      const authHeader = await this.credential.getAuthorizationHeader(storageOAuthScope);
      headers.set("Authorization", authHeader);
    } else if (this.credential instanceof StorageSharedKeyCredential) {
      if (this.accountName.length === 0) {
        throw new Error("Unable to extract accountName from URL for shared key signing");
      }

      headers.set("Authorization", applyBlobSharedKeyAuth(method, url, headers, this.credential));
    }

    const response = await this.fetcher(url.toString(), {
      method,
      headers,
      body: options.body,
    });

    return response;
  }

  private async *listContainersByPage(options?: QueryOptions): AsyncGenerator<ListContainersSegment> {
    let continuationToken = options?.continuationToken;
    const maxPageSize = options?.maxPageSize;

    while (true) {
      const response = await this.request("GET", this.url, {
        query: {
          comp: "list",
          ...(maxPageSize != null ? { maxresults: String(Math.min(maxPageSize, maxBlobPageSize)) } : undefined),
          ...(continuationToken != null ? { marker: continuationToken } : undefined),
        },
      });

      if (!response.ok) {
        throw new Error(`Container list failed: ${response.status} ${response.statusText}`);
      }

      const xml = await response.text();
      const page = parseListContainersXml(xml);
      const nextMarker = page.nextMarker;

      yield {
        segment: {
          containerItems: page.segment.containerItems,
        },
        continuationToken: nextMarker,
        nextMarker,
      };

      if (!nextMarker) {
        break;
      }

      continuationToken = nextMarker;
    }
  }
}

export class ContainerClient {
  constructor(
    public readonly url: string,
    private readonly credential: CredentialLike,
    private readonly fetcher: typeof globalThis.fetch,
  ) {}

  public getBlockBlobClient(blobName: string): BlockBlobClient {
    const blobUrl = appendToURLPath(this.url, encodeBlobName(blobName));
    return new BlockBlobClient(blobUrl, this.credential, this.fetcher);
  }

  public getBlobBatchClient(): BlobBatchClient {
    return new BlobBatchClient(this.url, this.credential, this.fetcher);
  }

  public async createIfNotExists(): Promise<ContainerCreateIfNotExistsResponse> {
    const response = await this.request("PUT", this.url, { query: { restype: "container" } });
    if (response.status === 201) {
      return { succeeded: true };
    }

    if (response.status === 409) {
      return { succeeded: false };
    }

    if (!response.ok) {
      throw new Error(`Container create failed: ${response.status} ${response.statusText}`);
    }

    return { succeeded: false };
  }

  public async deleteIfExists(): Promise<BlobDeleteIfExistsResponse> {
    const response = await this.request("DELETE", this.url, { query: { restype: "container" } });
    if (response.status === 202 || response.status === 204 || response.status === 404) {
      return {
        succeeded: response.status !== 404,
        errorCode: response.status === 404 ? "ContainerNotFound" : undefined,
      };
    }

    if (!response.ok) {
      throw new Error(`Container delete failed: ${response.status} ${response.statusText}`);
    }

    return { succeeded: true };
  }

  public async exists(): Promise<boolean> {
    const response = await this.request("HEAD", this.url, { query: { restype: "container" } });
    if (response.status === 404) {
      return false;
    }

    if (!response.ok) {
      throw new Error(`Container exists check failed: ${response.status} ${response.statusText}`);
    }

    return true;
  }

  public listBlobsFlat(): { byPage: (options?: QueryOptions) => AsyncIterable<ListBlobsFlatSegment> } {
    return {
      byPage: (options) => this.listBlobsFlatByPage(options),
    };
  }

  public async deleteBlob(blobName: string, options?: { deleteSnapshots?: "include" | "only" }): Promise<void> {
    await this.getBlockBlobClient(blobName).deleteIfExists(options);
  }

  private async *listBlobsFlatByPage(options?: QueryOptions): AsyncGenerator<ListBlobsFlatSegment> {
    let continuationToken = options?.continuationToken;
    const maxPageSize = options?.maxPageSize;

    while (true) {
      const response = await this.request("GET", this.url, {
        query: {
          comp: "list",
          restype: "container",
          ...(maxPageSize != null ? { maxresults: String(Math.min(maxPageSize, maxBlobPageSize)) } : undefined),
          ...(continuationToken != null ? { marker: continuationToken } : undefined),
        },
      });

      if (!response.ok) {
        throw new Error(`Blob list failed: ${response.status} ${response.statusText}`);
      }

      const xml = await response.text();
      const page = parseListBlobsFlatXml(xml);

      const nextMarker = page.nextMarker;
      yield {
        segment: {
          blobItems: page.segment.blobItems,
        },
        continuationToken: nextMarker,
        nextMarker,
      };

      if (!nextMarker) {
        break;
      }

      continuationToken = nextMarker;
    }
  }

  private async request(
    method: string,
    targetUrl: string,
    options: { query?: Record<string, string> } = {},
  ): Promise<Response> {
    const url = new URL(targetUrl);
    addQueryParameters(url, options.query);

    const service = new BlobServiceClientProxy(this.url, this.credential, this.fetcher);
    return service.request(method, url.toString());
  }
}

export class BlobBatch {
  private readonly batchBoundary: string;
  private readonly multipartContentType: string;
  private readonly batchRequestEnding: string;
  private readonly subRequests: Map<number, BlobBatchSubRequest>;
  private readonly defaultCredential?: CredentialLike;

  constructor(defaultCredential?: CredentialLike) {
    this.batchBoundary = createBatchBoundary();
    this.multipartContentType = `multipart/mixed; boundary=${this.batchBoundary}`;
    this.batchRequestEnding = `--${this.batchBoundary}--${multipartLineEnding}`;
    this.subRequests = new Map();
    this.defaultCredential = defaultCredential;
  }

  public getMultiPartContentType(): string {
    return this.multipartContentType;
  }

  public getHttpRequestBody(): string {
    const parts: string[] = [];

    for (const [operationIndex, subRequest] of this.subRequests) {
      parts.push(this.getSubRequestHeader(operationIndex));
      parts.push(`${subRequest.method} ${subRequest.uri} HTTP/1.1`);

      for (const [name, value] of Object.entries(subRequest.headers)) {
        if (value.length > 0) {
          parts.push(`${name}: ${value}`);
        }
      }

      parts.push("");
      parts.push("");
    }

    return `${parts.join(multipartLineEnding)}${multipartLineEnding}${this.batchRequestEnding}`;
  }

  public getSubRequests(): Map<number, BlobBatchSubRequest> {
    return this.subRequests;
  }

  public async deleteBlob(
    blobUrl: string,
    _credential: CredentialLike,
    options?: BlobBatchDeleteBlobOptions,
  ): Promise<void> {
    if (this.subRequests.size >= batchMaxRequestCount) {
      throw new RangeError(`Cannot exceed ${batchMaxRequestCount} sub requests in a single batch`);
    }

    const uri = extractBlobUri(blobUrl);
    const headers: Record<string, string> = {};

    if (options?.deleteSnapshots != null) {
      headers["x-ms-delete-snapshots"] = options.deleteSnapshots;
    }

    const requestCredential = _credential ?? this.defaultCredential;
    await addAuthenticationHeadersForSubRequest("DELETE", blobUrl, headers, requestCredential);

    const operationIndex = this.subRequests.size;
    this.subRequests.set(operationIndex, {
      method: "DELETE",
      uri,
      url: blobUrl,
      credential: requestCredential,
      headers,
    });
  }

  private getSubRequestHeader(operationId: number): string {
    return [
      `--${this.batchBoundary}`,
      "Content-Type: application/http",
      "Content-Transfer-Encoding: binary",
      `Content-ID: ${operationId}`,
      "",
    ].join(multipartLineEnding);
  }
}

export class BlobBatchClient {
  private readonly serviceUrl: string;

  constructor(
    private readonly url: string,
    private readonly credential: CredentialLike,
    private readonly fetcher: typeof globalThis.fetch,
  ) {
    this.serviceUrl = validateUrl(url);
  }

  public createBatch(): BlobBatch {
    return new BlobBatch(this.credential);
  }

  public async submitBatch(batch: BlobBatch, _options: BlobOperationOptions = {}): Promise<BlobBatchSubmitResponse> {
    if (batch.getSubRequests().size === 0) {
      throw new RangeError("Batch request should contain one or more sub requests.");
    }

    const batchUrl = new URL(this.serviceUrl);
    batchUrl.searchParams.set("comp", "batch");

    const response = await new BlobServiceClientProxy(this.serviceUrl, this.credential, this.fetcher).request(
      "POST",
      batchUrl,
      {
        headers: {
          "Content-Type": batch.getMultiPartContentType(),
        },
        body: batch.getHttpRequestBody(),
      },
    );

    if (!response.ok || response.status !== 202) {
      const body = await response.text();
      throw new Error(`Blob batch submit failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
    }

    const parsed = await parseBlobBatchResponse(response, batch);

    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      requestId: response.headers.get("x-ms-request-id") ?? undefined,
      errorCode: response.headers.get("x-ms-error-code") ?? undefined,
      subResponses: parsed.subResponses,
      subResponsesSucceededCount: parsed.subResponsesSucceededCount,
      subResponsesFailedCount: parsed.subResponsesFailedCount,
    };
  }
}

export class BlockBlobClient {
  constructor(
    public readonly url: string,
    private readonly credential: CredentialLike,
    private readonly fetcher: typeof globalThis.fetch,
  ) {}

  public async upload(body: string | ArrayBuffer | ArrayBufferView | Blob, _contentLength?: number): Promise<Response> {
    const requestBody = normalizeUploadBody(body);
    const contentLength = _contentLength;

    const response = await this.request("PUT", this.url, {
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "Content-Type": "application/octet-stream",
        ...(contentLength != null ? { "Content-Length": String(contentLength) } : undefined),
      },
      body: requestBody,
    });

    if (!response.ok) {
      throw new Error(`Blob upload failed: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  public async download(offset = 0, count?: number): Promise<Response> {
    const headers: HeadersInit = {};
    if (offset > 0 || count != null) {
      const range = `bytes=${offset}-${count == null ? "" : offset + count - 1}`;
      headers.Range = range;
    }

    const response = await this.request("GET", this.url, { headers });
    if (!response.ok && response.status !== 206) {
      throw new Error(`Blob download failed: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  public async downloadToBuffer(offset = 0, count?: number): Promise<Uint8Array> {
    const response = await this.download(offset, count);
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  public async deleteIfExists(options?: { deleteSnapshots?: "include" | "only" }): Promise<BlobDeleteIfExistsResponse> {
    const response = await this.request("DELETE", this.url, {
      headers: options?.deleteSnapshots
        ? {
            "x-ms-delete-snapshots": options.deleteSnapshots,
          }
        : undefined,
    });
    if (response.status === 404) {
      return {
        succeeded: false,
        errorCode: "BlobNotFound",
      };
    }

    if (response.status !== 202 && response.status !== 204) {
      if (!response.ok) {
        throw new Error(`Blob delete failed: ${response.status} ${response.statusText}`);
      }
    }

    return { succeeded: response.status !== 404 };
  }

  public async exists(): Promise<boolean> {
    const response = await this.request("HEAD", this.url);
    if (response.status === 404) {
      return false;
    }

    if (!response.ok) {
      throw new Error(`Blob exists check failed: ${response.status} ${response.statusText}`);
    }

    return true;
  }

  public async getProperties(): Promise<BlobGetPropertiesResponse> {
    const response = await this.request("HEAD", this.url);
    if (!response.ok) {
      throw new Error(`Blob getProperties failed: ${response.status} ${response.statusText}`);
    }

    const metadata = parseMetadataFromHeaders(response.headers);

    return {
      etag: response.headers.get("etag") ?? undefined,
      lastModified: parseDateHeader(response.headers.get("last-modified")),
      lastAccessed: parseDateHeader(response.headers.get("x-ms-last-access-time")),
      createdOn: parseDateHeader(response.headers.get("x-ms-creation-time")),
      metadata,
    };
  }

  private async request(method: string, targetUrl: string, options: BlobOperationOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers ?? {});
    const service = new BlobServiceClientProxy(this.url, this.credential, this.fetcher);
    return service.request(method, targetUrl, {
      headers,
      body: options.body,
    });
  }
}

class BlobServiceClientProxy {
  public readonly accountName: string;

  constructor(
    private readonly url: string,
    private readonly credential: CredentialLike,
    private readonly fetcher: typeof globalThis.fetch,
  ) {
    this.accountName = getAccountNameFromUrl(url);
  }

  public async request(method: string, targetUrl: string, options: BlobOperationOptions = {}): Promise<Response> {
    const url = new URL(targetUrl);
    const headers = new Headers(options.headers);
    applyStorageDateAndVersionHeaders(headers);
    setKnownContentLength(headers, options.body);

    if (this.credential instanceof DefaultAzureCredential) {
      headers.set("Authorization", await this.credential.getAuthorizationHeader(storageOAuthScope));
    } else if (this.credential instanceof StorageSharedKeyCredential) {
      if (!this.accountName) {
        throw new Error("Unable to extract accountName from URL for shared key signing");
      }

      headers.set("Authorization", applyBlobSharedKeyAuth(method, url, headers, this.credential));
    }

    return this.fetcher(url, {
      method,
      headers,
      body: options.body,
    });
  }
}

function parseMetadataFromHeaders(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lowerCaseName = name.toLowerCase();
    if (lowerCaseName.startsWith("x-ms-meta-")) {
      metadata[lowerCaseName.slice("x-ms-meta-".length)] = value;
    }
  }

  return metadata;
}

function parseDateHeader(raw: string | null): Date | undefined {
  if (raw == null) {
    return undefined;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseConnectionString(connectionString: string): ParsedConnectionString {
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

  const blobEndpoint = parts.BlobEndpoint?.replace(/\/$/, "");
  const accountKey = parts.AccountKey;
  const defaultProtocol = parts.DefaultEndpointsProtocol?.toLowerCase();
  const endpointSuffix = parts.EndpointSuffix;
  const accountSas = parts.SharedAccessSignature;
  const accountName = parts.AccountName || (blobEndpoint ? getAccountNameFromUrl(blobEndpoint) : "");

  if (defaultProtocol != null && accountKey != null) {
    const protocol = defaultProtocol;
    if (protocol !== "https" && protocol !== "http") {
      throw new Error(
        "Invalid DefaultEndpointsProtocol in the provided Connection String. Expecting 'https' or 'http'",
      );
    }

    if (!endpointSuffix && !blobEndpoint) {
      throw new Error("Invalid EndpointSuffix in the provided Connection String");
    }

    const endpoint = blobEndpoint || `${protocol}://${accountName}.blob.${endpointSuffix}`;
    if (!endpoint) {
      throw new Error("Invalid BlobEndpoint in the provided Connection String");
    }

    if (!accountName) {
      throw new Error("Invalid AccountName in the provided Connection String");
    }

    if (Buffer.from(accountKey, "base64").length === 0) {
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
    if (!blobEndpoint) {
      throw new Error("Invalid BlobEndpoint in the provided SAS Connection String");
    }

    if (!accountName) {
      throw new Error("Invalid AccountName in the provided SAS Connection String");
    }

    return {
      kind: "SASConnString",
      url: blobEndpoint,
      accountName,
      accountSas: accountSas.replace(/^\?/, ""),
    };
  }

  throw new Error("Connection string must be either an Account connection string or a SAS connection string");
}

function validateUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
    return new URL(`${parsed.origin}${parsed.pathname.slice(0, -1)}`).toString();
  }

  return parsed.toString();
}

function encodeBlobName(name: string): string {
  return name
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function appendToURLPath(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = basePath + "/" + path;
  return url.toString().replace(/\/$/, "");
}

function parseListBlobsFlatXml(xml: string): ListBlobsFlatSegment {
  const nextMarker = extractFirst(xml, /<NextMarker>([\s\S]*?)<\/NextMarker>/)?.trim() || "";
  const segment: BlobItem[] = [];

  const blobPattern = /<Blob>([\s\S]*?)<\/Blob>/g;
  for (const match of xml.matchAll(blobPattern)) {
    const blobXml = match[1];
    const name = extractFirst(blobXml, /<Name>([\s\S]*?)<\/Name>/);
    if (name == null) {
      continue;
    }
    segment.push({ name: decodeXml(name.trim()) });
  }

  return {
    segment: { blobItems: segment },
    nextMarker,
  };
}

function parseListContainersXml(xml: string): ListContainersSegment {
  const nextMarker = extractFirst(xml, /<NextMarker>([\s\S]*?)<\/NextMarker>/)?.trim() || "";
  const segment: ContainerItem[] = [];

  const containerPattern = /<Container>([\s\S]*?)<\/Container>/g;
  for (const match of xml.matchAll(containerPattern)) {
    const containerXml = match[1];
    const name = extractFirst(containerXml, /<Name>([\s\S]*?)<\/Name>/);
    if (name == null) {
      continue;
    }

    segment.push({ name: decodeXml(name.trim()) });
  }

  return {
    segment: { containerItems: segment },
    nextMarker,
  };
}

function normalizeUploadBody(
  body: string | ArrayBuffer | ArrayBufferView | Blob,
): string | ArrayBuffer | ArrayBufferView | Blob {
  if (typeof body === "string" || body instanceof Blob || ArrayBuffer.isView(body) || body instanceof ArrayBuffer) {
    return body;
  }

  return String(body);
}

function createBatchBoundary(): string {
  if (typeof crypto.randomUUID === "function") {
    return `batch_${crypto.randomUUID()}`;
  }

  return `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function extractBlobUri(blobUrl: string): string {
  const url = new URL(blobUrl);
  const path = url.pathname || "/";
  const query = url.search || "";

  return `${path}${query}`;
}

async function addAuthenticationHeadersForSubRequest(
  method: string,
  subRequestUrl: string,
  headers: Record<string, string>,
  credential?: CredentialLike,
): Promise<void> {
  if (credential == null) {
    return;
  }

  if (headers["x-ms-date"] == null) {
    headers["x-ms-date"] = new Date().toUTCString();
  }

  if (credential instanceof DefaultAzureCredential) {
    headers.Authorization = await credential.getAuthorizationHeader(storageOAuthScope);
    return;
  }

  if (credential instanceof StorageSharedKeyCredential) {
    const accountName = getAccountNameFromUrl(subRequestUrl);
    if (accountName.length === 0) {
      return;
    }

    const url = new URL(subRequestUrl);
    const requestHeaders = new Headers(headers);
    const signingCredential = {
      accountName,
      computeHMACSHA256: (stringToSign: string) => credential.computeHMACSHA256(stringToSign),
    };

    headers.Authorization = applyBlobSharedKeyAuth(method, url, requestHeaders, signingCredential);
  }
}

function getBoundaryFromContentType(contentType: string | null): string {
  if (contentType == null || !contentType.includes("boundary=")) {
    throw new Error("Blob batch response missing boundary");
  }

  const boundary = contentType.split("boundary=")[1]?.trim();
  if (boundary == null || boundary.length === 0) {
    throw new Error("Blob batch response boundary is empty");
  }

  return boundary;
}

function parseHeaderLine(rawHeader: string): { name: string; value: string } {
  const delimiter = ": ";
  const index = rawHeader.indexOf(delimiter);
  if (index < 0) {
    throw new Error(`Invalid header line in batch response: ${rawHeader}`);
  }

  return {
    name: rawHeader.slice(0, index),
    value: rawHeader.slice(index + delimiter.length),
  };
}

async function parseBlobBatchResponse(
  response: Response,
  batch: BlobBatch,
): Promise<{
  subResponses: Array<BlobBatchSubResponse | undefined>;
  subResponsesSucceededCount: number;
  subResponsesFailedCount: number;
}> {
  const contentType = response.headers.get("content-type");
  const boundary = getBoundaryFromContentType(contentType);
  const responseText = await response.text();
  const responseBoundary = `--${boundary}`;
  const responseBoundaryEnd = `${responseBoundary}--`;

  const subResponses: Array<BlobBatchSubResponse | undefined> = [];
  let subResponsesSucceededCount = 0;
  let subResponsesFailedCount = 0;

  if (!responseText.includes(responseBoundaryEnd)) {
    throw new Error("Blob batch response is malformed or missing closing boundary");
  }

  const rawSubResponses = responseText
    .split(responseBoundary)
    .slice(1, -1)
    .map((raw) => raw.replace(/^\r?\n/, ""))
    .filter((raw) => raw.trim().length > 0);

  if (rawSubResponses.length !== batch.getSubRequests().size) {
    throw new Error("Blob batch response sub response count does not match sub request count");
  }

  const subRequests = batch.getSubRequests();

  for (const rawSubResponse of rawSubResponses) {
    const lines = rawSubResponse.split(/\r\n/);
    const parsed: BlobBatchSubResponse = { headers: {} };
    let headerStartFound = false;
    let headerEndFound = false;
    let contentId = Number.NaN;

    for (const line of lines) {
      if (!headerStartFound) {
        if (line.toLowerCase().startsWith("content-id:")) {
          const parsedContentId = parseInt(line.slice("content-id:".length).trim(), 10);
          if (!Number.isNaN(parsedContentId)) {
            contentId = parsedContentId;
          }
        }

        if (line.startsWith("HTTP/1.1")) {
          headerStartFound = true;
          const statusTokens = line.split(" ");
          const status = Number.parseInt(statusTokens[1] || "", 10);
          parsed.status = Number.isNaN(status) ? 0 : status;
          parsed.statusMessage = statusTokens.slice(2).join(" ");
        }

        continue;
      }

      if (line.trim() === "") {
        headerEndFound = true;
        continue;
      }

      if (!headerEndFound) {
        const { name, value } = parseHeaderLine(line);
        if (!parsed.headers) {
          parsed.headers = {};
        }
        parsed.headers[name] = value;
        if (name.toLowerCase() === "x-ms-error-code") {
          parsed.errorCode = value;
        }
        continue;
      }

      if (line.length > 0) {
        parsed.bodyAsText = `${parsed.bodyAsText || ""}${line}`;
      }
    }

    if (headerEndFound) {
      const isSuccess = parsed.status >= 200 && parsed.status < 300;
      if (!isSuccess || parsed.errorCode != null) {
        subResponsesFailedCount += 1;
      } else {
        subResponsesSucceededCount += 1;
      }
    }

    let mapped = parsed as BlobBatchSubResponse;
    if (Number.isInteger(contentId) && contentId >= 0 && contentId < subRequests.size) {
      mapped = {
        ...parsed,
        _request: subRequests.get(contentId),
      };

      if (subResponses[contentId] == null) {
        subResponses[contentId] = mapped;
      }
    } else {
      subResponses.push(mapped);
    }
  }

  while (subResponses.length < subRequests.size) {
    subResponses.push(undefined);
  }

  return {
    subResponses,
    subResponsesSucceededCount,
    subResponsesFailedCount,
  };
}

function extractFirst(input: string, regex: RegExp): string | undefined {
  const match = input.match(regex);
  return match?.[1];
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function getAccountNameFromUrl(url: string): string {
  const parsedUrl = new URL(url);
  const hostParts = parsedUrl.hostname.split(".");

  if (hostParts[1] === "blob" || hostParts[1] === "table") {
    return hostParts[0] || "";
  }

  if (isIpEndpointStyle(parsedUrl)) {
    return parsedUrl.pathname.split("/").filter(Boolean)[0] ?? "";
  }

  return "";
}

function isIpEndpointStyle(parsedUrl: URL): boolean {
  const host = parsedUrl.hostname;

  return host === "localhost" || host === "host.docker.internal" || /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}
