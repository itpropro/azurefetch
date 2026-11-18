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
 * doubled apostrophes and Dates become `datetime'…'` literals. A string interpolated inside
 * a quoted template literal is escaped without adding a second pair of quotes.
 */
export function odata(strings: TemplateStringsArray, ...values: unknown[]): string {
  let filter = ''
  let quoted = false
  for (const [index, text] of strings.entries()) {
    filter += text
    if (text.split("'").length % 2 === 0) {
      quoted = !quoted
    }
    if (index < values.length) {
      filter += odataLiteral(values[index], quoted)
    }
  }
  return filter
}

function odataLiteral(value: unknown, quoted: boolean): string {
  if (value instanceof Date) {
    const iso = Date.prototype.toISOString.call(value)
    return quoted ? iso : `datetime'${iso}'`
  }

  if (typeof value === 'string') {
    const escaped = value.replaceAll("'", "''")
    return quoted ? escaped : `'${escaped}'`
  }
  if (typeof value === 'bigint') {
    return quoted ? String(value) : `${String(value)}L`
  }

  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return String(value)
  }

  throw new TypeError('Unsupported OData literal value')
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
