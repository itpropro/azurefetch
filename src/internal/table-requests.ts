import { storageRequestError } from './storage-request'
import type { StorageTransport } from './storage-request'
import { appendUrlPath } from './storage-url'

export interface TableCreateIfNotExistsResponse {
  succeeded: boolean
  errorCode?: string
}

export interface TableDeleteResponse {
  succeeded: boolean
  errorCode?: string
}

/** Escapes a key for an OData path literal such as `Tables('name')`. */
export function escapeODataKey(key: string): string {
  return encodeURIComponent(key.replaceAll("'", "''"))
}

export async function createTable(
  transport: StorageTransport,
  serviceUrl: string,
  tableName: string,
): Promise<TableCreateIfNotExistsResponse> {
  const response = await transport.send('POST', appendUrlPath(serviceUrl, 'Tables'), {
    headers: { 'Content-Type': 'application/json', Prefer: 'return-no-content' },
    body: JSON.stringify({ TableName: tableName }),
  })
  if (response.status === 409) {
    return { succeeded: false, errorCode: 'TableAlreadyExists' }
  }

  if (!response.ok) {
    throw storageRequestError('Create table', response)
  }

  return { succeeded: true }
}

export async function deleteTable(
  transport: StorageTransport,
  serviceUrl: string,
  tableName: string,
): Promise<TableDeleteResponse> {
  const tableUrl = appendUrlPath(serviceUrl, `Tables('${escapeODataKey(tableName)}')`)
  const response = await transport.send('DELETE', tableUrl)
  if (response.status === 404) {
    return { succeeded: false, errorCode: 'TableNotFound' }
  }

  if (!response.ok) {
    throw storageRequestError('Delete table', response)
  }

  return { succeeded: true }
}
