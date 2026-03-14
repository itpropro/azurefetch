import { createHmac } from "node:crypto";

import { getDefaultAzureCredentialToken } from "./default-credential";
import type { AccessToken } from "./types";

const storageOAuthScope = "https://storage.azure.com/.default";
const xmsServiceVersion = "2024-11-04";

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

export interface BlobDeleteIfExistsResponse {
  succeeded: boolean;
  errorCode?: string;
}

export interface ContainerCreateIfNotExistsResponse {
  succeeded: boolean;
}

export class DefaultAzureCredential {
  constructor(private readonly options: DefaultAzureCredentialOptions = {}) {}

  public async getToken(scopes: string | string[]): Promise<AccessToken> {
    const normalizedScopes = normalizeScopes(scopes);
    return getDefaultAzureCredentialToken({
      scope: normalizedScopes,
      fetch: this.options.fetch,
      authorityHost: this.options.authorityHost,
    });
  }

  public async getAuthorizationHeader(scopes: string | string[] = storageOAuthScope): Promise<string> {
    const token = await this.getToken(scopes);
    return `${token.tokenType} ${token.token}`;
  }
}

interface DefaultAzureCredentialOptions {
  authorityHost?: string;
  fetch?: typeof globalThis.fetch;
}

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

  public async request(method: string, inputUrl: string, options: BlobOperationOptions = {}): Promise<Response> {
    const url = new URL(inputUrl);
    const headers = new Headers(options.headers ?? {});
    const bodyLength = getKnownBodyLength(options.body);

    if (!headers.has("x-ms-date")) {
      headers.set("x-ms-date", new Date().toUTCString());
    }

    if (!headers.has("x-ms-version")) {
      headers.set("x-ms-version", xmsServiceVersion);
    }

    if (this.credential instanceof DefaultAzureCredential) {
      const authHeader = await this.credential.getAuthorizationHeader(storageOAuthScope);
      headers.set("Authorization", authHeader);
    } else if (this.credential instanceof StorageSharedKeyCredential) {
      if (this.accountName.length === 0) {
        throw new Error("Unable to extract accountName from URL for shared key signing");
      }

      if (bodyLength != null) {
        headers.set("Content-Length", String(bodyLength));
      }

      const stringToSign = buildStringToSign(method, url, headers, this.accountName);
      const signature = this.credential.computeHMACSHA256(stringToSign);
      headers.set("Authorization", `SharedKey ${this.accountName}:${signature}`);
    }

    const response = await this.fetcher(inputUrl, {
      method,
      headers,
      body: options.body,
    });

    return response;
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
          ...(maxPageSize != null ? { maxresults: String(maxPageSize) } : undefined),
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
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }

    const service = new BlobServiceClientProxy(this.url, this.credential, this.fetcher);
    return service.request(method, url.toString());
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
    const service = new BlobServiceClientProxy(new URL(targetUrl).origin, this.credential, this.fetcher);
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

    if (!headers.has("x-ms-date")) {
      headers.set("x-ms-date", new Date().toUTCString());
    }

    if (!headers.has("x-ms-version")) {
      headers.set("x-ms-version", xmsServiceVersion);
    }

    if (this.credential instanceof DefaultAzureCredential) {
      headers.set("Authorization", await this.credential.getAuthorizationHeader(storageOAuthScope));
    } else if (this.credential instanceof StorageSharedKeyCredential) {
      if (!this.accountName) {
        throw new Error("Unable to extract accountName from URL for shared key signing");
      }

      const contentLength = getKnownBodyLength(options.body);
      if (contentLength != null) {
        headers.set("Content-Length", String(contentLength));
      }

      const stringToSign = buildStringToSign(method, url, headers, this.accountName);
      const signature = this.credential.computeHMACSHA256(stringToSign);
      headers.set("Authorization", `SharedKey ${this.accountName}:${signature}`);
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

function normalizeScopes(scope: string | string[]): string {
  const scopes = Array.isArray(scope) ? scope : [scope];
  const value = scopes[0];
  if (!value) {
    throw new Error("At least one scope is required");
  }

  return value;
}

function parseConnectionString(connectionString: string): ParsedConnectionString {
  const useDevelopment = connectionString.startsWith("UseDevelopmentStorage=true");
  const normalizedConnectionString = useDevelopment
    ? "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;"
    : connectionString;

  const parts = Object.fromEntries(
    normalizedConnectionString
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

function normalizeUploadBody(
  body: string | ArrayBuffer | ArrayBufferView | Blob,
): string | ArrayBuffer | ArrayBufferView | Blob {
  if (typeof body === "string" || body instanceof Blob || ArrayBuffer.isView(body) || body instanceof ArrayBuffer) {
    return body;
  }

  return String(body);
}

function getKnownBodyLength(body: BodyInit | null | undefined): number | undefined {
  if (body == null) {
    return undefined;
  }

  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength;
  }

  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }

  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }

  if (body instanceof Blob) {
    return body.size;
  }

  return undefined;
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

  if (hostParts[1] === "blob") {
    return hostParts[0] || "";
  }

  if (isIpEndpointStyle(parsedUrl)) {
    return parsedUrl.pathname.split("/").filter(Boolean)[0] ?? "";
  }

  return "";
}

function isIpEndpointStyle(parsedUrl: URL): boolean {
  const host = parsedUrl.host;

  return (
    /^.*:.*:.*$|^(localhost|host.docker.internal)(:[0-9]+)?$|^([0-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])(\.([0-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])){3}(:[0-9]+)?$/.test(
      host,
    ) ||
    (Boolean(parsedUrl.port) &&
      [
        "10000",
        "10001",
        "10002",
        "10003",
        "10004",
        "10100",
        "10101",
        "10102",
        "10103",
        "10104",
        "11000",
        "11001",
        "11002",
        "11003",
        "11004",
        "11100",
        "11101",
        "11102",
        "11103",
        "11104",
      ].includes(parsedUrl.port))
  );
}

function buildStringToSign(method: string, url: URL, headers: Headers, accountName: string): string {
  const contentEncoding = headers.get("Content-Encoding") ?? "";
  const contentLanguage = headers.get("Content-Language") ?? "";
  const contentLength = headers.get("Content-Length") ?? "";
  const contentMd5 = headers.get("Content-MD5") ?? "";
  const contentType = headers.get("Content-Type") ?? "";
  const date = "";
  const ifModifiedSince = headers.get("If-Modified-Since") ?? "";
  const ifMatch = headers.get("If-Match") ?? "";
  const ifNoneMatch = headers.get("If-None-Match") ?? "";
  const ifUnmodifiedSince = headers.get("If-Unmodified-Since") ?? "";
  const range = headers.get("Range") ?? "";

  const canonicalizedHeaders = canonicalizeHeaders(headers);

  const canonicalizedResource = canonicalizeResource(url, accountName);

  return [
    method.toUpperCase(),
    contentEncoding,
    contentLanguage,
    contentLength,
    contentMd5,
    contentType,
    date,
    ifModifiedSince,
    ifMatch,
    ifNoneMatch,
    ifUnmodifiedSince,
    range,
    "",
    canonicalizedHeaders,
    canonicalizedResource,
  ].join("\n");
}

function canonicalizeHeaders(headers: Headers): string {
  const normalized: string[] = [];

  for (const [name, value] of headers.entries()) {
    const lowerCase = name.toLowerCase();
    if (!lowerCase.startsWith("x-ms-")) {
      continue;
    }

    normalized.push(`${lowerCase}:${value.trim()}`);
  }

  normalized.sort();
  return normalized.join("\n");
}

function canonicalizeResource(url: URL, accountName: string): string {
  const path = url.pathname || "/";
  const canonicalizedResource = `/${accountName}${path}`;

  const queryParameters: Record<string, string[]> = {};
  for (const [name, value] of url.searchParams.entries()) {
    const lowerName = name.toLowerCase();
    if (!queryParameters[lowerName]) {
      queryParameters[lowerName] = [];
    }

    queryParameters[lowerName].push(value);
  }

  const queryString = Object.entries(queryParameters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, values]) => `${name}:${values.join(",")}`)
    .join("\n");

  if (queryString.length === 0) {
    return canonicalizedResource;
  }

  return `${canonicalizedResource}\n${queryString}`;
}
