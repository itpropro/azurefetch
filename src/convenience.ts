import { addQueryParameters } from "./internal/storage-request";
import { AzureClient, type AzureRequestInit } from "./client";
import type { TableEntity } from "./table";

const defaultTextContentType = "text/plain; charset=utf-8";
const maxTablePageSize = 1000;

type TableUpsertMode = "Replace" | "Merge";

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

export async function downloadJson<T = unknown>(
  client: AzureClient,
  blobUrl: string,
  options: BlobTextRequestOptions = {},
): Promise<BlobDownloadJsonResponse<T>> {
  const { response, text } = await downloadText(client, blobUrl, options);

  let value: T;
  try {
    value = JSON.parse(text) as T;
  } catch {
    throw new Error(`downloadJson failed: unable to parse response body for ${blobUrl}`);
  }

  return {
    response,
    value,
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

  const raw = await response.json();
  return {
    response,
    entity: parseTableEntity(raw),
  };
}

export async function upsertEntity(
  client: AzureClient,
  tableUrl: string,
  entity: TableEntity | Record<string, unknown>,
  updateMode: TableUpsertMode = "Replace",
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

  if (updateMode !== "Replace") {
    throw new Error(`Unsupported table upsert mode: ${updateMode}`);
  }

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

  while (true) {
    const requestQuery: Record<string, string> = {};
    if (maxPageSize != null) {
      requestQuery["$top"] = String(Math.min(maxPageSize, maxTablePageSize));
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

    const body = await response.text();
    const entities = parseTableEntityList(body);
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
      return;
    }

    nextContinuationToken = pageContinuationToken;
  }
}

interface ContinuationState {
  partitionKey: string;
  rowKey: string;
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

function buildTableEntityUrl(tableUrl: string, partitionKey: string, rowKey: string): string {
  const encodedPartitionKey = encodeURIComponent(partitionKey.replaceAll("'", "''"));
  const encodedRowKey = encodeURIComponent(rowKey.replaceAll("'", "''"));
  return `${normalizeTableUrl(tableUrl)}(PartitionKey='${encodedPartitionKey}',RowKey='${encodedRowKey}')`;
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

function parseTableEntityList(body: string): TableEntity[] {
  if (body.length === 0) {
    return [];
  }

  const parsed = JSON.parse(body) as { value?: unknown };
  if (parsed == null || typeof parsed !== "object") {
    return [];
  }

  const rawEntities = parsed.value;
  if (!Array.isArray(rawEntities)) {
    return [];
  }

  const entities: TableEntity[] = [];
  for (const entity of rawEntities) {
    if (entity == null || typeof entity !== "object") {
      continue;
    }

    const candidate = entity as { [key: string]: unknown };
    if (typeof candidate.PartitionKey !== "string" || typeof candidate.RowKey !== "string") {
      continue;
    }

    entities.push(parseTableEntity(candidate));
  }

  return entities;
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

function encodeContinuationToken(state: ContinuationState): string {
  const params = new URLSearchParams();
  params.set("NextPartitionKey", state.partitionKey);
  params.set("NextRowKey", state.rowKey);
  return params.toString();
}
