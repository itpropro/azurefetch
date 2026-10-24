import { jsonProperty } from './json'

/** Table properties are JSON primitives; the service infers their types. */
export type TableEntityProperty = string | number | boolean | null

export interface TableEntity {
  partitionKey: string
  rowKey: string
  [property: string]: TableEntityProperty
}

export function serializeEntity({ partitionKey, rowKey, ...properties }: TableEntity): string {
  return JSON.stringify({ ...properties, PartitionKey: partitionKey, RowKey: rowKey })
}

export function parseEntity(value: unknown): TableEntity {
  const partitionKey = jsonProperty(value, 'PartitionKey')
  const rowKey = jsonProperty(value, 'RowKey')
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Invalid table entity response')
  }

  if (typeof partitionKey !== 'string' || typeof rowKey !== 'string') {
    throw new TypeError('Invalid table entity response')
  }

  const properties = Object.entries(value).filter(
    ([name]) => name !== 'PartitionKey' && name !== 'RowKey',
  )
  return { ...Object.fromEntries(properties), partitionKey, rowKey }
}

export function parseEntityList(value: unknown): TableEntity[] {
  const entities = jsonProperty(value, 'value')
  return Array.isArray(entities) ? entities.map((entity) => parseEntity(entity)) : []
}
