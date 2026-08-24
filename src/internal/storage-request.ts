import { encodeUtf8 } from "./storage-encoding";

export const storageServiceVersion = "2024-11-04";

export interface BlobSharedKeyCredential {
  readonly accountName: string;
  computeHMACSHA256(stringToSign: string): Promise<string>;
}

export function addQueryParameters(url: URL, query?: Record<string, string>): void {
  if (query == null) {
    return;
  }

  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
}

export function applyStorageDateAndVersionHeaders(headers: Headers, version = storageServiceVersion): void {
  if (!headers.has("x-ms-date")) {
    headers.set("x-ms-date", new Date().toUTCString());
  }

  if (!headers.has("x-ms-version")) {
    headers.set("x-ms-version", version);
  }
}

export function getKnownBodyLength(body: BodyInit | null | undefined): number | undefined {
  if (body == null) {
    return undefined;
  }

  if (typeof body === "string") {
    return encodeUtf8(body).byteLength;
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

export function setKnownContentLength(headers: Headers, body: BodyInit | null | undefined): void {
  const bodyLength = getKnownBodyLength(body);
  if (bodyLength != null) {
    headers.set("Content-Length", String(bodyLength));
  }
}

export async function applyBlobSharedKeyAuth(
  method: string,
  url: URL,
  headers: Headers,
  credential: BlobSharedKeyCredential,
): Promise<string> {
  const stringToSign = buildBlobStringToSign(method, url, headers, credential.accountName);
  const signature = await credential.computeHMACSHA256(stringToSign);
  return `SharedKey ${credential.accountName}:${signature}`;
}

export async function applyTableSharedKeyLiteAuth(
  method: string,
  url: URL,
  headers: Headers,
  credential: BlobSharedKeyCredential,
): Promise<string> {
  const stringToSign = buildTableStringToSign(credential.accountName, url, headers);
  const signature = await credential.computeHMACSHA256(stringToSign);
  return `SharedKeyLite ${credential.accountName}:${signature}`;
}

function buildBlobStringToSign(method: string, url: URL, headers: Headers, accountName: string): string {
  const contentEncoding = headers.get("Content-Encoding") ?? "";
  const contentLanguage = headers.get("Content-Language") ?? "";
  const contentLengthHeader = headers.get("Content-Length");
  const contentLength = contentLengthHeader === "0" ? "" : (contentLengthHeader ?? "");
  const contentMd5 = headers.get("Content-MD5") ?? "";
  const contentType = headers.get("Content-Type") ?? "";
  const date = "";
  const ifModifiedSince = headers.get("If-Modified-Since") ?? "";
  const ifMatch = headers.get("If-Match") ?? "";
  const ifNoneMatch = headers.get("If-None-Match") ?? "";
  const ifUnmodifiedSince = headers.get("If-Unmodified-Since") ?? "";
  const range = headers.get("Range") ?? "";

  const canonicalizedHeaders = canonicalizeBlobHeaders(headers);
  const canonicalizedResource = buildBlobCanonicalizedResource(url, accountName);

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
    canonicalizedHeaders,
    canonicalizedResource,
  ].join("\n");
}

function canonicalizeBlobHeaders(headers: Headers): string {
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

function buildBlobCanonicalizedResource(url: URL, accountName: string): string {
  const path = url.pathname;
  const canonicalizedResource = `/${accountName}${path}`;

  const queryParameters: Record<string, string[]> = {};
  for (const [name, value] of url.searchParams.entries()) {
    const lowerName = name.toLowerCase();
    queryParameters[lowerName] ??= [];

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

function buildTableStringToSign(accountName: string, url: URL, headers: Headers): string {
  const date = headers.get("x-ms-date") ?? headers.get("Date") ?? "";
  const canonicalizedResource = buildTableCanonicalizedResource(url, accountName);
  return `${date}\n${canonicalizedResource}`;
}

function buildTableCanonicalizedResource(url: URL, accountName: string): string {
  const normalizedPath = url.pathname;
  const canonicalizedResource = `/${accountName}${normalizedPath}`;
  const comp = url.searchParams.get("comp");
  if (comp == null) {
    return canonicalizedResource;
  }

  return `${canonicalizedResource}?comp=${comp}`;
}
