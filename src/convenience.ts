import { encodeContinuationToken, parseContinuationToken } from "./internal/continuation-token";
import {
  getPartitionKey,
  getRowKey,
  normalizeEntityPayload,
  parseTableEntity,
  parseTableEntityList,
} from "./internal/table-entity";
import { addQueryParameters } from "./internal/storage-request";
import { AzureClient, type AzureRequestInit } from "./client";
import type { TableEntity } from "./table";

const defaultTextContentType = "text/plain; charset=utf-8";
const maxTablePageSize = 1000;

type TableUpsertMode = "Replace";

type BlobTextRequestOptions = Omit<AzureRequestInit, "method" | "body">;
type TableEntityOptions = Omit<AzureRequestInit, "method" | "body">;

export interface BlobUploadTextOptions extends BlobTextRequestOptions {
  contentType?: string;
}

export interface BlobDownloadTextResponse {
  response: Response;
  text: string;
}

export interface BlobDownloadJsonResponse<T> {
  response: Response;
  value: T;
}

export interface TableGetEntityResponse {
  response: Response;
  entity?: TableEntity;
}

export interface TableUpsertEntityResponse {
  response: Response;
  created: boolean;
}

export interface TableEntityPage {
  response: Response;
  entities: TableEntity[];
  continuationToken?: string;
  nextPartitionKey?: string;
  nextRowKey?: string;
}

export interface TableListEntitiesOptions extends TableEntityOptions {
  continuationToken?: string;
  maxPageSize?: number;
}

export async function uploadText(
  client: AzureClient,
  blobUrl: string,
  text: string,
  options: BlobUploadTextOptions = {},
): Promise<Response> {
  const { contentType, headers, ...requestInit } = options;
  const requestHeaders = ensureHeaders(headers, {
    "Content-Type": contentType ?? defaultTextContentType,
  });

  const response = await client.fetch(blobUrl, {
    ...requestInit,
    method: "PUT",
    headers: requestHeaders,
    body: text,
  });

  if (!response.ok) {
    throw new Error(`uploadText failed: ${response.status} ${response.statusText}`);
  }

  return response;
}

export async function downloadText(
  client: AzureClient,
  blobUrl: string,
  options: BlobTextRequestOptions = {},
): Promise<BlobDownloadTextResponse> {
  const response = await client.fetch(blobUrl, {
    ...options,
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`downloadText failed: ${response.status} ${response.statusText}`);
  }

  return {
    response,
    text: await response.text(),
  };
}

export function downloadJson(
  client: AzureClient,
  blobUrl: string,
  options: BlobTextRequestOptions = {},
): Promise<BlobDownloadJsonResponse<unknown>>;
export function downloadJson<T>(
  client: AzureClient,
  blobUrl: string,
  options: BlobTextRequestOptions,
  parseValue: (value: unknown) => T,
): Promise<BlobDownloadJsonResponse<T>>;
export async function downloadJson<T>(
  client: AzureClient,
  blobUrl: string,
  options: BlobTextRequestOptions = {},
  parseValue?: (value: unknown) => T,
): Promise<BlobDownloadJsonResponse<T> | BlobDownloadJsonResponse<unknown>> {
  const { response, text } = await downloadText(client, blobUrl, options);

  let value: unknown;
  try {
    value = parseJson(text);
  } catch {
    throw new Error(`downloadJson failed: unable to parse response body for ${blobUrl}`);
  }

  if (parseValue == null) {
    return { response, value };
  }

  return {
    response,
    value: parseValue(value),
  };
}

export async function getEntity(
  client: AzureClient,
  tableUrl: string,
  partitionKey: string,
  rowKey: string,
  options: TableEntityOptions = {},
): Promise<TableGetEntityResponse> {
  const requestUrl = buildTableEntityUrl(tableUrl, partitionKey, rowKey);
  const response = await client.fetch(requestUrl, {
    ...options,
    method: "GET",
  });

  if (response.status === 404) {
    return {
      response,
      entity: undefined,
    };
  }

  if (!response.ok) {
    throw new Error(`getEntity failed: ${response.status} ${response.statusText}`);
  }

  const raw = parseJson(await response.text());
  return {
    response,
    entity: parseTableEntity(raw),
  };
}

export async function upsertEntity(
  client: AzureClient,
  tableUrl: string,
  entity: TableEntity | Record<string, unknown>,
  _updateMode: TableUpsertMode = "Replace",
  options: TableEntityOptions = {},
): Promise<TableUpsertEntityResponse> {
  const normalizedPartitionKey = getPartitionKey(entity);
  const normalizedRowKey = getRowKey(entity);
  const payload = normalizeEntityPayload(entity, normalizedPartitionKey, normalizedRowKey);
  const requestEntityUrl = buildTableEntityUrl(tableUrl, normalizedPartitionKey, normalizedRowKey);
  const putHeaders = ensureHeaders(options.headers, {
    "Content-Type": "application/json",
    Accept: "application/json;odata=nometadata",
    Prefer: "return-no-content",
    "If-Match": "*",
  });

  const body = JSON.stringify(payload);
  const putResponse = await client.fetch(requestEntityUrl, {
    ...options,
    method: "PUT",
    headers: putHeaders,
    body,
  });

  if (putResponse.ok || putResponse.status === 204) {
    return {
      response: putResponse,
      created: false,
    };
  }

  if (putResponse.status !== 404) {
    throw new Error(`upsertEntity failed: ${putResponse.status} ${putResponse.statusText}`);
  }

  const postHeaders = ensureHeaders(options.headers, {
    "Content-Type": "application/json",
    Accept: "application/json;odata=nometadata",
    Prefer: "return-no-content",
  });

  const postResponse = await client.fetch(tableUrl, {
    ...options,
    method: "POST",
    headers: postHeaders,
    body,
  });

  if (!postResponse.ok && postResponse.status !== 204) {
    throw new Error(`upsertEntity failed: ${postResponse.status} ${postResponse.statusText}`);
  }

  return {
    response: postResponse,
    created: true,
  };
}

export async function* listEntitiesPage(
  client: AzureClient,
  tableUrl: string,
  options: TableListEntitiesOptions = {},
): AsyncGenerator<TableEntityPage> {
  const { continuationToken, maxPageSize, headers, ...requestInit } = options;
  let nextContinuationToken = continuationToken;
  let hasMore = true;

  while (hasMore) {
    const requestQuery: Record<string, string> = {};
    if (maxPageSize != null) {
      requestQuery.$top = String(Math.min(maxPageSize, maxTablePageSize));
    }

    const parsedContinuation = parseContinuationToken(nextContinuationToken);
    if (parsedContinuation != null) {
      requestQuery.NextPartitionKey = parsedContinuation.partitionKey;
      requestQuery.NextRowKey = parsedContinuation.rowKey;
    }

    const requestUrl = new URL(`${normalizeTableUrl(tableUrl)}()`);
    addQueryParameters(requestUrl, requestQuery);

    const requestHeaders = ensureHeaders(headers, {
      Accept: "application/json;odata=nometadata",
    });

    const response = await client.fetch(requestUrl.toString(), {
      ...requestInit,
      method: "GET",
      headers: requestHeaders,
    });

    if (!response.ok) {
      throw new Error(`listEntitiesPage failed: ${response.status} ${response.statusText}`);
    }

    const entities = parseTableEntityList(await response.text());
    const nextPartitionKey = response.headers.get("x-ms-continuation-NextPartitionKey");
    const nextRowKey = response.headers.get("x-ms-continuation-NextRowKey");
    const hasNext =
      nextPartitionKey != null && nextPartitionKey.length > 0 && nextRowKey != null && nextRowKey.length > 0;
    const pageContinuationToken = hasNext
      ? encodeContinuationToken({ partitionKey: nextPartitionKey, rowKey: nextRowKey })
      : undefined;

    yield {
      response,
      entities,
      continuationToken: pageContinuationToken,
      nextPartitionKey,
      nextRowKey,
    };

    if (!hasNext) {
      hasMore = false;
      continue;
    }

    nextContinuationToken = pageContinuationToken;
  }
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function ensureHeaders(input: HeadersInit | undefined, defaults: Record<string, string>): Headers {
  const headers = new Headers(input);

  for (const [name, value] of Object.entries(defaults)) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }

  return headers;
}

function normalizeTableUrl(rawTableUrl: string): string {
  const parsed = new URL(rawTableUrl);
  return parsed.toString().replace(/\/$/, "");
}

function buildTableEntityUrl(tableUrl: string, partitionKey: string, rowKey: string): string {
  const encodedPartitionKey = encodeURIComponent(partitionKey.replaceAll("'", "''"));
  const encodedRowKey = encodeURIComponent(rowKey.replaceAll("'", "''"));
  return `${normalizeTableUrl(tableUrl)}(PartitionKey='${encodedPartitionKey}',RowKey='${encodedRowKey}')`;
}
