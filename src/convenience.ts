import { BlockBlobClient } from './block-blob-client'
import type { AzureClient } from './client'
import type { ListOptions } from './internal/paging'
import type { StorageClientOptions } from './internal/storage-request'
import type { TableEntity } from './internal/table-entity'
import { TableClient } from './table-client'

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
  entity?: TableEntity
}

export interface TableEntityPage {
  entities: TableEntity[]
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
): Promise<void> {
  await new TableClient(tableUrl, undefined, through(client)).upsertEntity(entity)
}

export async function* listEntitiesPage(
  client: AzureClient,
  tableUrl: string,
  options?: ListOptions,
): AsyncGenerator<TableEntityPage> {
  const table = new TableClient(tableUrl, undefined, through(client))
  for await (const { value, continuationToken } of table.listEntities().byPage(options)) {
    yield { entities: value, continuationToken }
  }
}

/** Storage clients without a credential send through the AzureClient, which authorizes them. */
function through(client: AzureClient): StorageClientOptions {
  return { fetch: async (input, init) => await client.fetch(input, init) }
}
