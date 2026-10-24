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

/**
 * Builds an OData filter such as odata`RowKey eq ${rowKey}`. Strings become quoted literals with
 * doubled apostrophes and Dates become `datetime'…'` literals. As in the Azure SDK, strings that
 * the template already quotes or that follow no text are escaped but not quoted.
 */
export function odata(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings
    .flatMap((text, index) =>
      index < values.length ? [text, odataLiteral(values[index], text)] : [text],
    )
    .join('')
}

function odataLiteral(value: unknown, previousText: string): unknown {
  if (value instanceof Date) {
    return `datetime'${value.toISOString()}'`
  }

  if (typeof value !== 'string') {
    return value
  }

  const escaped = value.replaceAll("'", "''")
  return previousText === '' || previousText.trim().endsWith("'") ? escaped : `'${escaped}'`
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
  // Other conflicts, such as TableBeingDeleted, are failures.
  if (response.status === 409 && response.headers.get('x-ms-error-code') === 'TableAlreadyExists') {
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
