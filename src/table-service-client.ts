import {
  StorageTransport,
  parseStorageConnectionString,
  storageAccountName,
  tableProtocol,
} from './internal/storage-request'
import type { StorageClientOptions, StorageCredential } from './internal/storage-request'
import { appendUrlPath, normalizeStorageUrl } from './internal/storage-url'
import { createTable, deleteTable } from './internal/table-requests'
import type { TableCreateIfNotExistsResponse, TableDeleteResponse } from './internal/table-requests'
import { TableClient } from './table-client'

export class TableServiceClient {
  public readonly accountName: string
  public readonly url: string
  private readonly credential: StorageCredential | undefined
  private readonly options: StorageClientOptions | undefined
  private readonly transport: StorageTransport

  public constructor(url: string, credential?: StorageCredential, options?: StorageClientOptions) {
    this.url = normalizeStorageUrl(url)
    this.accountName = storageAccountName(url, credential)
    this.credential = credential
    this.options = options
    this.transport = new StorageTransport(credential, options, tableProtocol)
  }

  public static fromConnectionString(
    connectionString: string,
    options?: StorageClientOptions,
  ): TableServiceClient {
    const { url, credential } = parseStorageConnectionString(connectionString, 'table')
    return new TableServiceClient(url, credential, options)
  }

  public getTableClient(tableName: string): TableClient {
    const url = appendUrlPath(this.url, encodeURIComponent(tableName))
    return new TableClient(url, this.credential, this.options)
  }

  public async createTableIfNotExists(tableName: string): Promise<TableCreateIfNotExistsResponse> {
    return await createTable(this.transport, this.url, tableName)
  }

  public async deleteTableIfExists(tableName: string): Promise<TableDeleteResponse> {
    return await deleteTable(this.transport, this.url, tableName)
  }
}
