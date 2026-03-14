export const storageServiceVersion = "2024-11-04";

export interface BlobSharedKeyCredential {
  readonly accountName: string;
  computeHMACSHA256(stringToSign: string): string;
}

export interface TableSharedKeyLiteCredential {
  readonly accountName: string;
  readonly accountKey: string;
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

export function setKnownContentLength(headers: Headers, body: BodyInit | null | undefined): void {
  const bodyLength = getKnownBodyLength(body);
  if (bodyLength != null) {
    headers.set("Content-Length", String(bodyLength));
  }
}

export function applyBlobSharedKeyAuth(
  method: string,
  url: URL,
  headers: Headers,
  credential: BlobSharedKeyCredential,
): string {
  const stringToSign = buildBlobStringToSign(method, url, headers, credential.accountName);
  const signature = credential.computeHMACSHA256(stringToSign);
  return `SharedKey ${credential.accountName}:${signature}`;
}

export async function applyTableSharedKeyLiteAuth(
  method: string,
  url: URL,
  headers: Headers,
  credential: TableSharedKeyLiteCredential,
): Promise<string> {
  const stringToSign = buildTableStringToSign(credential.accountName, url, headers);
  const signature = await computeSharedKeyLiteSignature(credential.accountKey, stringToSign);
  return `SharedKeyLite ${credential.accountName}:${signature}`;
}

function buildBlobStringToSign(method: string, url: URL, headers: Headers, accountName: string): string {
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

async function computeSharedKeyLiteSignature(accountKey: string, stringToSign: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle == null) {
    throw new Error("Web Crypto API is required for SharedKeyLite signing");
  }

  const keyBytes = decodeBase64ToBytes(accountKey);
  const cryptoKey = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(stringToSign));
  return encodeBytesToBase64(signature);
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

function encodeBytesToBase64(bytes: ArrayBuffer | ArrayBufferView): string {
  if (typeof globalThis.btoa !== "function") {
    throw new Error("btoa is required to encode shared key signatures");
  }

  const signatureBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of signatureBytes) {
    binary += String.fromCharCode(byte);
  }

  return globalThis.btoa(binary);
}
