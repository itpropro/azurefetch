import * as fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { decodeBase64ToBytes, encodeBytesToBase64 } from '../src/internal/storage-encoding'
import { parseEntity, serializeEntity } from '../src/internal/table-entity'
import type {
  TableEntity,
  TableEntityProperty,
  TableEntityValue,
} from '../src/internal/table-entity'

/** A property as written and the value a read returns for it; null properties are not stored. */
type PropertyRoundTrip = [written: TableEntityProperty, read: TableEntityValue | undefined]

const etag = `W/"datetime'2026-10-25T12%3A00%3A00.0000000Z'"`

/** The service returns the stored properties together with the entity's etag. */
function entityResponse(body: string): unknown {
  const value: unknown = JSON.parse(body)
  return typeof value === 'object' && value !== null ? { ...value, 'odata.etag': etag } : value
}

// The codec maps these names to system properties or OData annotations.
const systemNames = new Set([
  'partitionKey',
  'rowKey',
  'etag',
  'timestamp',
  'PartitionKey',
  'RowKey',
  'Timestamp',
])

const propertyName = fc
  .oneof(
    fc.string({ unit: 'binary' }),
    fc.constantFrom('__proto__', 'constructor', 'prototype', 'toString'),
  )
  .filter(
    (name) => !systemNames.has(name) && !name.startsWith('odata.') && !name.endsWith('@odata.type'),
  )

const property = fc.oneof(
  fc.string({ unit: 'binary' }).map((value): PropertyRoundTrip => [value, value]),
  fc.boolean().map((value): PropertyRoundTrip => [value, value]),
  // JSON has no NaN, Infinity or negative zero.
  fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .filter((value) => !Object.is(value, -0))
    .map((value): PropertyRoundTrip => [value, value]),
  fc.constant(null).map((value): PropertyRoundTrip => [value, undefined]),
  fc.date({ noInvalidDate: true }).map((value): PropertyRoundTrip => [value, value]),
  fc
    .bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n })
    .map((value): PropertyRoundTrip => [value, value]),
  fc.uint8Array().map((value): PropertyRoundTrip => [value, value]),
  fc.uuid().map((value): PropertyRoundTrip => [
    { value, type: 'Guid' },
    { value, type: 'Guid' },
  ]),
  fc
    .integer({ min: -(2 ** 31), max: 2 ** 31 - 1 })
    .map((value): PropertyRoundTrip => [{ value, type: 'Int32' }, value]),
)

const entity = fc.record({
  partitionKey: fc.string({ unit: 'binary' }),
  rowKey: fc.string({ unit: 'binary' }),
  properties: fc.uniqueArray(fc.tuple(propertyName, property), { selector: ([name]) => name }),
})

describe('table entity codec', () => {
  test('reads back the properties it writes', () => {
    fc.assert(
      fc.property(entity, ({ partitionKey, rowKey, properties }) => {
        // Entries keep a property named __proto__ as an own property.
        const written: TableEntity = {
          ...Object.fromEntries(properties.map(([name, [value]]) => [name, value])),
          partitionKey,
          rowKey,
        }
        const read = properties.flatMap(([name, [, value]]): [string, TableEntityValue][] =>
          value === undefined ? [] : [[name, value]],
        )
        const parsed = parseEntity(entityResponse(serializeEntity(written)))

        // As map keys, names such as `constructor` can't shadow what the comparison reads.
        expect(new Map(Object.entries(parsed))).toStrictEqual(
          new Map([...read, ['partitionKey', partitionKey], ['rowKey', rowKey], ['etag', etag]]),
        )
      }),
    )
  })
})

const byteView = fc
  .uint8Array()
  .chain((bytes) =>
    fc
      .tuple(fc.nat(bytes.length), fc.nat(bytes.length))
      .map(([start, end]) => bytes.subarray(Math.min(start, end), Math.max(start, end))),
  )

describe('base64 codec', () => {
  test('encodes any byte view like Buffer and decodes it back', () => {
    fc.assert(
      fc.property(byteView, (view) => {
        const base64 = encodeBytesToBase64(view)

        expect(base64).toBe(Buffer.from(view).toString('base64'))
        expect(decodeBase64ToBytes(base64)).toStrictEqual(Uint8Array.from(view))
      }),
    )
  })
})
