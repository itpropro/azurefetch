import { AzureRequestError } from './azure-request-error'
import { paginate } from './internal/paging'
import type { ListOptions } from './internal/paging'
import { encodeUtf8 } from './internal/storage-encoding'
import {
  StorageTransport,
  multipartBoundary,
  storageRequestError,
  tableProtocol,
} from './internal/storage-request'
import type { StorageClientOptions, StorageCredential } from './internal/storage-request'
import { appendUrlPath, extendUrlPath, normalizeStorageUrl } from './internal/storage-url'
import { parseEntity, parseEntityList, serializeEntity } from './internal/table-entity'
import type { TableEntity } from './internal/table-entity'
import { createTable, deleteTable, escapeODataKey } from './internal/table-requests'
import type { TableCreateIfNotExistsResponse, TableDeleteResponse } from './internal/table-requests'

export type TableTransactionAction =
  | { action: 'create' | 'update' | 'upsert'; entity: TableEntity }
  | { action: 'delete'; partitionKey: string; rowKey: string }

export interface TableTransactionResponse {
  status: number
  subResponses: { status: number }[]
}

export interface TableEntityResponse {
  readonly value: TableEntity[]
  continuationToken?: string
}

// The Table service returns at most 1,000 entities per query request.
const maxTablePageSize = 1000
const subResponseStatusPattern = /HTTP\/1\.[01] (\d{3})/gu

export class TableClient {
  public readonly url: string
  public readonly tableName: string
  private readonly serviceUrl: string
  private readonly transport: StorageTransport

  /** `url` addresses the table, for example `https://account.table.core.windows.net/mytable`. */
  public constructor(url: string, credential?: StorageCredential, options?: StorageClientOptions) {
    this.url = normalizeStorageUrl(url)
    const serviceUrl = new URL(this.url)
    const segments = serviceUrl.pathname.split('/')
    this.tableName = decodeURIComponent(segments.pop() ?? '')
    serviceUrl.pathname = segments.join('/')
    this.serviceUrl = serviceUrl.toString()
    this.transport = new StorageTransport(credential, options, tableProtocol)
  }

  public async createIfNotExists(): Promise<TableCreateIfNotExistsResponse> {
    return await createTable(this.transport, this.serviceUrl, this.tableName)
  }

  public async deleteIfExists(): Promise<TableDeleteResponse> {
    return await deleteTable(this.transport, this.serviceUrl, this.tableName)
  }

  public async getEntity(partitionKey: string, rowKey: string): Promise<TableEntity | undefined> {
    const response = await this.transport.send('GET', this.entityUrl(partitionKey, rowKey))
    if (response.status === 404) {
      return undefined
    }

    if (!response.ok) {
      throw storageRequestError('Get entity', response)
    }

    return parseEntity(await response.json())
  }

  /** Inserts the entity or replaces an existing one with the same keys. */
  public async upsertEntity(entity: TableEntity): Promise<void> {
    const response = await this.transport.send(
      'PUT',
      this.entityUrl(entity.partitionKey, entity.rowKey),
      { headers: { 'Content-Type': 'application/json' }, body: serializeEntity(entity) },
    )
    if (!response.ok) {
      throw storageRequestError('Upsert entity', response)
    }
  }

  public async deleteEntity(partitionKey: string, rowKey: string): Promise<TableDeleteResponse> {
    const response = await this.transport.send('DELETE', this.entityUrl(partitionKey, rowKey), {
      headers: { 'If-Match': '*' },
    })
    if (response.status === 404) {
      return { succeeded: false, errorCode: 'ResourceNotFound' }
    }

    if (!response.ok) {
      throw storageRequestError('Delete entity', response)
    }

    return { succeeded: true }
  }

  public listEntities(): { byPage: (options?: ListOptions) => AsyncIterable<TableEntityResponse> } {
    return {
      byPage: (options = {}) =>
        paginate(async (continuationToken) => {
          const top =
            options.maxPageSize === undefined
              ? undefined
              : String(Math.min(options.maxPageSize, maxTablePageSize))
          const response = await this.transport.send('GET', extendUrlPath(this.url, '()'), {
            query: { $top: top, ...Object.fromEntries(new URLSearchParams(continuationToken)) },
          })
          if (!response.ok) {
            throw storageRequestError('List entities', response)
          }

          const next = new URLSearchParams()
          for (const name of ['NextPartitionKey', 'NextRowKey']) {
            const value = response.headers.get(`x-ms-continuation-${name}`)
            if (value !== null && value !== '') {
              next.set(name, value)
            }
          }

          const nextToken = next.size > 0 ? next.toString() : undefined
          const value = parseEntityList(await response.json())
          return { page: { value, continuationToken: nextToken }, continuationToken: nextToken }
        }, options.continuationToken),
    }
  }

  /** Runs all actions atomically; they must target one partition and distinct entities. */
  public async submitTransaction(
    actions: TableTransactionAction[],
  ): Promise<TableTransactionResponse> {
    const batch = multipartBoundary('batch')
    const changeset = multipartBoundary('changeset')
    const tableUrl = new URL(this.url)
    tableUrl.search = ''
    const lines = [`--${batch}`, `Content-Type: multipart/mixed; boundary=${changeset}`, '']

    for (const [index, action] of actions.entries()) {
      const { method, url, body, ifMatch } = transactionRequest(action, tableUrl.toString())
      lines.push(
        `--${changeset}`,
        'Content-Type: application/http',
        'Content-Transfer-Encoding: binary',
        `Content-ID: ${index + 1}`,
        '',
        `${method} ${url} HTTP/1.1`,
        'Accept: application/json;odata=nometadata',
        ...(body === undefined
          ? []
          : [
              'Content-Type: application/json',
              'Prefer: return-no-content',
              `Content-Length: ${encodeUtf8(body).byteLength}`,
            ]),
        ...(ifMatch ? ['If-Match: *'] : []),
        '',
        body ?? '',
      )
    }
    lines.push(`--${changeset}--`, `--${batch}--`, '')

    const response = await this.transport.send('POST', appendUrlPath(this.serviceUrl, '$batch'), {
      headers: { Accept: 'application/json', 'Content-Type': `multipart/mixed; boundary=${batch}` },
      body: lines.join('\r\n'),
    })
    if (!response.ok) {
      throw storageRequestError('Table transaction', response)
    }

    const subResponses = Array.from(
      (await response.text()).matchAll(subResponseStatusPattern),
      ([, status]) => ({ status: Number(status) }),
    )
    const failed = subResponses.find(({ status }) => status < 200 || status >= 300)
    if (failed !== undefined) {
      throw new AzureRequestError(
        `Table transaction failed: sub-response returned ${failed.status}`,
        failed.status,
      )
    }

    if (subResponses.length !== actions.length) {
      throw new Error(
        `Table transaction response contained ${subResponses.length} sub-responses; expected ${actions.length}`,
      )
    }

    return { status: response.status, subResponses }
  }

  private entityUrl(partitionKey: string, rowKey: string): string {
    return extendUrlPath(this.url, entityPath(partitionKey, rowKey))
  }
}

function entityPath(partitionKey: string, rowKey: string): string {
  return `(PartitionKey='${escapeODataKey(partitionKey)}',RowKey='${escapeODataKey(rowKey)}')`
}

function transactionRequest(
  action: TableTransactionAction,
  tableUrl: string,
): { method: string; url: string; body?: string; ifMatch: boolean } {
  if (action.action === 'delete') {
    return {
      method: 'DELETE',
      url: extendUrlPath(tableUrl, entityPath(action.partitionKey, action.rowKey)),
      ifMatch: true,
    }
  }

  const { entity } = action
  const body = serializeEntity(entity)
  return action.action === 'create'
    ? { method: 'POST', url: tableUrl, body, ifMatch: false }
    : {
        method: 'PUT',
        url: extendUrlPath(tableUrl, entityPath(entity.partitionKey, entity.rowKey)),
        body,
        ifMatch: action.action === 'update',
      }
}
