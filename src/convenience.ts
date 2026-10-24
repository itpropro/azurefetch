import { BlockBlobClient } from './block-blob-client'
import type { AzureClient } from './client'
import type { ListOptions } from './internal/paging'
import type { StorageClientOptions } from './internal/storage-request'
import type { TableEntity, TableEntityResult } from './internal/table-entity'
import { TableClient } from './table-client'
import type {
  TableEntityQueryOptions,
  TableEntityWriteResponse,
  TableUpdateMode,
} from './table-client'

export interface BlobUploadTextOptions {
  /** Defaults to `text/plain; charset=utf-8`. */
  contentType?: string
}

export interface BlobDownloadTextResponse {
  text: string
}

export interface BlobDownloadJsonResponse<T> {
  value: T
}

export interface TableGetEntityResponse {
  entity?: TableEntityResult
}

export interface TableEntityPage {
  entities: TableEntityResult[]
  continuationToken?: string
}

export async function uploadText(
  client: AzureClient,
  blobUrl: string,
  text: string,
  options: BlobUploadTextOptions = {},
): Promise<Response> {
  return await new BlockBlobClient(blobUrl, undefined, through(client)).upload(text, {
    contentType: options.contentType ?? 'text/plain; charset=utf-8',
  })
}

export async function downloadText(
  client: AzureClient,
  blobUrl: string,
): Promise<BlobDownloadTextResponse> {
  const response = await new BlockBlobClient(blobUrl, undefined, through(client)).download()
  return { text: await response.text() }
}

export async function downloadJson(
  client: AzureClient,
  blobUrl: string,
): Promise<BlobDownloadJsonResponse<unknown>>
export async function downloadJson<T>(
  client: AzureClient,
  blobUrl: string,
  parse: (value: unknown) => T,
): Promise<BlobDownloadJsonResponse<T>>
export async function downloadJson<T>(
  client: AzureClient,
  blobUrl: string,
  parse?: (value: unknown) => T,
): Promise<BlobDownloadJsonResponse<unknown>> {
  const value: unknown = JSON.parse((await downloadText(client, blobUrl)).text)
  return { value: parse === undefined ? value : parse(value) }
}

export async function getEntity(
  client: AzureClient,
  tableUrl: string,
  partitionKey: string,
  rowKey: string,
): Promise<TableGetEntityResponse> {
  const table = new TableClient(tableUrl, undefined, through(client))
  return { entity: await table.getEntity(partitionKey, rowKey) }
}

export async function upsertEntity(
  client: AzureClient,
  tableUrl: string,
  entity: TableEntity,
  mode?: TableUpdateMode,
): Promise<TableEntityWriteResponse> {
  return await new TableClient(tableUrl, undefined, through(client)).upsertEntity(entity, mode)
}

export async function* listEntitiesPage(
  client: AzureClient,
  tableUrl: string,
  { filter, select, ...pageOptions }: ListOptions & TableEntityQueryOptions = {},
): AsyncGenerator<TableEntityPage> {
  const table = new TableClient(tableUrl, undefined, through(client))
  const pages = table.listEntities({ filter, select }).byPage(pageOptions)
  for await (const { value, continuationToken } of pages) {
    yield { entities: value, continuationToken }
  }
}

/** Storage clients without a credential send through the AzureClient, which authorizes and retries. */
function through(client: AzureClient): StorageClientOptions {
  return {
    fetch: async (input, init) => await client.fetch(input, init),
    retryOptions: { maxRetries: 0 },
  }
}
