import { jsonProperty } from './json'
import { decodeBase64ToBytes, encodeBytesToBase64 } from './storage-encoding'

/** A property with an explicit EDM type; Binary is base64, DateTime ISO and Int64 decimal text. */
export type TableEdmProperty =
  | { value: string; type: 'Binary' | 'DateTime' | 'Guid' | 'Int64' | 'String' }
  | { value: boolean; type: 'Boolean' }
  | { value: number; type: 'Double' | 'Int32' }

/** The service infers primitive types; Date, bigint and bytes become DateTime, Int64 and Binary. */
export type TableEntityProperty =
  | string
  | number
  | boolean
  | null
  | Date
  | bigint
  | Uint8Array
  | TableEdmProperty

export interface TableEntity {
  partitionKey: string
  rowKey: string
  [property: string]: TableEntityProperty
}

/** A property as read: DateTime, Int64 and Binary decode to Date, bigint and Uint8Array. */
export type TableEntityValue =
  | string
  | number
  | boolean
  | Date
  | bigint
  | Uint8Array
  | { value: string; type: 'Guid' }

/** An entity as read; a projection may omit the keys and timestamp. */
export interface TableEntityResult {
  partitionKey?: string
  rowKey?: string
  etag: string
  timestamp?: string
  [property: string]: TableEntityValue | undefined
}

/** Service names of the system properties, which reads rename and writes map back. */
const serviceNames = new Map([
  ['partitionKey', 'PartitionKey'],
  ['rowKey', 'RowKey'],
  ['etag', 'odata.etag'],
  ['timestamp', 'Timestamp'],
])
const publicNames = new Map(Array.from(serviceNames, ([name, serviceName]) => [serviceName, name]))

/** Annotated types without a JSON equivalent; other values stay as parsed. */
const decoders: Partial<Record<string, (value: string) => TableEntityValue>> = {
  'Edm.Binary': decodeBase64ToBytes,
  'Edm.DateTime': (value) => new Date(value),
  'Edm.Guid': (value) => ({ value, type: 'Guid' }),
  'Edm.Int64': BigInt,
}

// Entries become own properties, so a property such as `__proto__` keeps its name.
export function serializeEntity({ partitionKey, rowKey, ...properties }: TableEntity): string {
  const body = Object.entries(properties).flatMap(([name, property]) => {
    const serviceName = serviceNames.get(name) ?? name
    const [value, type] = encodeProperty(property)
    return type === undefined
      ? [[serviceName, value]]
      : [
          [serviceName, value],
          [`${serviceName}@odata.type`, type],
        ]
  })

  return JSON.stringify({
    ...Object.fromEntries(body),
    PartitionKey: partitionKey,
    RowKey: rowKey,
  })
}

/** `$select` of public property names; the etag is always returned and is not selectable. */
export function serializeSelect(names: string[]): string {
  return names
    .filter((name) => name !== 'etag' && name !== 'odata.etag')
    .map((name) => serviceNames.get(name) ?? name)
    .join(',')
}

export function parseEntity(value: unknown): TableEntityResult {
  const etag = jsonProperty(value, 'odata.etag')
  if (typeof value !== 'object' || value === null || typeof etag !== 'string') {
    throw new TypeError('Invalid table entity response')
  }

  const properties: [string, TableEntityValue][] = []
  const system: [string, string][] = []
  for (const name of Object.keys(value)) {
    const property = jsonProperty(value, name)
    const publicName = publicNames.get(name)
    if (publicName !== undefined) {
      if (typeof property === 'string') {
        system.push([publicName, property])
      }
    } else if (!name.startsWith('odata.') && !name.endsWith('@odata.type')) {
      const decoded = decodeProperty(property, jsonProperty(value, `${name}@odata.type`))
      if (decoded !== undefined) {
        properties.push([name, decoded])
      }
    }
  }

  // System properties win over user properties with the same name.
  return { ...Object.fromEntries(properties), ...Object.fromEntries(system), etag }
}

export function parseEntityList(value: unknown): TableEntityResult[] {
  const entities = jsonProperty(value, 'value')
  return Array.isArray(entities) ? entities.map((entity) => parseEntity(entity)) : []
}

function decodeProperty(property: unknown, type: unknown): TableEntityValue | undefined {
  if (typeof property === 'string') {
    const decode = typeof type === 'string' ? decoders[type] : undefined
    return decode === undefined ? property : decode(property)
  }

  return typeof property === 'number' || typeof property === 'boolean' ? property : undefined
}

function encodeProperty(
  property: TableEntityProperty,
): [value: string | number | boolean | null, type?: string] {
  if (property instanceof Date) {
    return [property.toISOString(), 'Edm.DateTime']
  }

  if (typeof property === 'bigint') {
    return [property.toString(), 'Edm.Int64']
  }

  if (property instanceof Uint8Array) {
    return [encodeBytesToBase64(property), 'Edm.Binary']
  }

  if (typeof property === 'object' && property !== null) {
    return [property.value, `Edm.${property.type}`]
  }

  return [property]
}
