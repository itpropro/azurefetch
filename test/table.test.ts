import { createHmac } from 'node:crypto'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { StorageSharedKeyCredential } from '../src/storage-shared-key-credential'
import { odata } from '../src/table'
import type { TableEntity } from '../src/table'
import { TableClient } from '../src/table-client'
import { TableServiceClient } from '../src/table-service-client'
import { collect, createFetchMock, getBodyString, jsonResponse, textResponse } from './helpers'

const accountUrl = 'https://myaccount.table.core.windows.net'
const tableUrl = `${accountUrl}/mytable`
const accountKey = 'bXlfYWNjb3VudF9rZXk='
const etag = `W/"datetime'2026-08-24T12%3A00%3A00.0000000Z'"`
const signWithAccountKey = (stringToSign: string) =>
  createHmac('sha256', Buffer.from(accountKey, 'base64')).update(stringToSign).digest('base64')

function anonymousTable(fetcher: typeof fetch, url = tableUrl): TableClient {
  return new TableClient(url, undefined, { fetch: fetcher })
}

function transactionResponseBody(statuses: number[]): string {
  const lines = [
    '--batchresponse_test',
    'Content-Type: multipart/mixed; boundary=changeset_test',
    '',
  ]
  for (const status of statuses) {
    lines.push(
      '--changeset_test',
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      `HTTP/1.1 ${status} Status`,
      '',
      '',
    )
  }
  lines.push('--changeset_test--', '--batchresponse_test--', '')
  return lines.join('\r\n')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TableServiceClient', () => {
  test('builds the table endpoint from an account key connection string', () => {
    const client = TableServiceClient.fromConnectionString(
      `DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=${accountKey};EndpointSuffix=core.windows.net`,
    )

    expect(client.url).toBe(`${accountUrl}/`)
  })

  test('signs requests with Shared Key Lite and sends the OData headers', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-24T12:00:00Z'), toFake: ['Date'] })
    let headers = new Headers()
    const fetcher = createFetchMock([
      (_url, init) => {
        headers = new Headers(init.headers)
        return jsonResponse({ 'odata.etag': etag, PartitionKey: 'pk', RowKey: 'rk', name: 'item' })
      },
    ])
    const credential = new StorageSharedKeyCredential('myaccount', accountKey)
    const client = new TableServiceClient(accountUrl, credential, { fetch: fetcher })

    const entity = await client.getTableClient('mytable').getEntity('pk', 'rk')

    expect(entity).toStrictEqual({ name: 'item', partitionKey: 'pk', rowKey: 'rk', etag })
    expect(headers.get('Authorization')).toBe(
      `SharedKeyLite myaccount:${signWithAccountKey(
        "Mon, 24 Aug 2026 12:00:00 GMT\n/myaccount/mytable(PartitionKey='pk',RowKey='rk')",
      )}`,
    )
    expect(headers.get('Accept')).toBe('application/json;odata=minimalmetadata')
    expect(headers.get('DataServiceVersion')).toBe('3.0;NetFx')
    expect(headers.get('MaxDataServiceVersion')).toBe('3.0;NetFx')
  })

  test('keeps the SAS query on entity, query and table URLs', async () => {
    const sas = 'sv=2024-11-04&sig=abc'
    const respondTo = (path: string, response: () => Response) => (url: string) => {
      const requestUrl = new URL(url)
      expect(`${requestUrl.pathname}${requestUrl.search}`).toBe(`${path}?${sas}`)
      return response()
    }
    const fetcher = createFetchMock([
      respondTo("/mytable(PartitionKey='pk',RowKey='rk')", () =>
        jsonResponse({ 'odata.etag': etag, PartitionKey: 'pk', RowKey: 'rk' }),
      ),
      respondTo('/mytable()', () => jsonResponse({ value: [] })),
      respondTo("/Tables('mytable')", () => textResponse('', 204)),
    ])
    const service = TableServiceClient.fromConnectionString(
      `TableEndpoint=${accountUrl}/;SharedAccessSignature=?${sas}`,
      { fetch: fetcher },
    )
    const table = service.getTableClient('mytable')

    await table.getEntity('pk', 'rk')
    await collect(table.listEntities().byPage())
    await service.deleteTableIfExists('mytable')

    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  test.each([
    { status: 204, result: { succeeded: true } },
    { status: 404, result: { succeeded: false, errorCode: 'TableNotFound' } },
  ])('maps a $status table delete response', async ({ status, result }) => {
    const fetcher = createFetchMock([() => textResponse('', status)])
    const client = new TableServiceClient(accountUrl, undefined, { fetch: fetcher })

    await expect(client.deleteTableIfExists('mytable')).resolves.toStrictEqual(result)
  })
})

describe('TableClient', () => {
  test('creates its table through the account endpoint of a trailing-slash URL', async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe('http://127.0.0.1:10002/devstoreaccount1/Tables')
        expect(getBodyString(init.body)).toBe('{"TableName":"mytable"}')
        return textResponse('', 409, 'Conflict', { 'x-ms-error-code': 'TableAlreadyExists' })
      },
    ])

    const table = anonymousTable(fetcher, 'http://127.0.0.1:10002/devstoreaccount1/mytable/')

    await expect(table.createIfNotExists()).resolves.toStrictEqual({
      succeeded: false,
      errorCode: 'TableAlreadyExists',
    })
  })

  test('reports a table that is still being deleted as a failed create', async () => {
    const fetcher = createFetchMock([
      () => textResponse('', 409, 'Conflict', { 'x-ms-error-code': 'TableBeingDeleted' }),
    ])

    await expect(anonymousTable(fetcher).createIfNotExists()).rejects.toMatchObject({
      status: 409,
      errorCode: 'TableBeingDeleted',
    })
  })

  test('decodes typed properties and prefers system properties over same-named ones', async () => {
    const fetcher = createFetchMock([
      () =>
        jsonResponse({
          'odata.metadata': `${accountUrl}/$metadata#mytable/@Element`,
          'odata.etag': etag,
          PartitionKey: 'pk',
          RowKey: 'rk',
          partitionKey: 'x',
          etag: 'user etag',
          text: 'text',
          integer: 42,
          double: 1.5,
          flag: true,
          'date@odata.type': 'Edm.DateTime',
          date: '2026-01-02T03:04:05.6789012Z',
          'big@odata.type': 'Edm.Int64',
          big: '9007199254740993',
          'bytes@odata.type': 'Edm.Binary',
          bytes: 'AQL/',
          'id@odata.type': 'Edm.Guid',
          id: '0f8fad5b-d9cb-469f-a165-70867728950e',
          Timestamp: '2026-08-24T12:00:00.0000000Z',
        }),
    ])

    await expect(anonymousTable(fetcher).getEntity('pk', 'rk')).resolves.toStrictEqual({
      partitionKey: 'pk',
      rowKey: 'rk',
      etag,
      timestamp: '2026-08-24T12:00:00.0000000Z',
      text: 'text',
      integer: 42,
      double: 1.5,
      flag: true,
      date: new Date('2026-01-02T03:04:05.678Z'),
      big: 9007199254740993n,
      bytes: new Uint8Array([1, 2, 255]),
      id: { value: '0f8fad5b-d9cb-469f-a165-70867728950e', type: 'Guid' },
    })
  })

  test('keeps a property named __proto__ when writing and reading an entity', async () => {
    const entity: TableEntity = { partitionKey: 'p', rowKey: 'r' }
    Object.defineProperty(entity, '__proto__', { value: 'value', enumerable: true })
    const bodies: string[] = []
    const fetcher = createFetchMock([
      (_url, init) => {
        bodies.push(getBodyString(init.body))
        return textResponse('', 204)
      },
      () =>
        textResponse(
          String.raw`{"odata.etag":"W/\"1\"","PartitionKey":"p","RowKey":"r","__proto__":"value"}`,
        ),
    ])
    const table = anonymousTable(fetcher)

    await table.upsertEntity(entity)
    const read = await table.getEntity('p', 'r')

    expect(bodies[0]).toContain('"__proto__":"value"')
    expect(read !== undefined && Object.hasOwn(read, '__proto__')).toBe(true)
  })

  test('returns undefined for a missing entity', async () => {
    const fetcher = createFetchMock([() => textResponse('', 404)])

    await expect(anonymousTable(fetcher).getEntity('pk', 'missing')).resolves.toBeUndefined()
  })

  test('creates entities with annotations for types the service cannot infer', async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        expect(init.method).toBe('POST')
        expect(url).toBe(tableUrl)
        expect(new Headers(init.headers).get('Prefer')).toBe('return-no-content')
        expect(JSON.parse(getBodyString(init.body))).toStrictEqual({
          text: 'text',
          integer: 42,
          flag: true,
          missing: null,
          date: '2026-01-02T03:04:05.678Z',
          'date@odata.type': 'Edm.DateTime',
          big: '9007199254740993',
          'big@odata.type': 'Edm.Int64',
          bytes: 'AQL/',
          'bytes@odata.type': 'Edm.Binary',
          binary: 'AQID',
          'binary@odata.type': 'Edm.Binary',
          boolean: false,
          'boolean@odata.type': 'Edm.Boolean',
          dateTime: '2026-01-02T03:04:05Z',
          'dateTime@odata.type': 'Edm.DateTime',
          double: 42,
          'double@odata.type': 'Edm.Double',
          guid: '0f8fad5b-d9cb-469f-a165-70867728950e',
          'guid@odata.type': 'Edm.Guid',
          int32: 7,
          'int32@odata.type': 'Edm.Int32',
          int64: '-1',
          'int64@odata.type': 'Edm.Int64',
          string: 'explicit',
          'string@odata.type': 'Edm.String',
          'odata.etag': etag,
          Timestamp: '2026-08-24T12:00:00Z',
          PartitionKey: 'pk',
          RowKey: 'rk',
        })
        return textResponse('', 204)
      },
    ])

    await anonymousTable(fetcher).createEntity({
      partitionKey: 'pk',
      rowKey: 'rk',
      text: 'text',
      integer: 42,
      flag: true,
      missing: null,
      date: new Date('2026-01-02T03:04:05.678Z'),
      big: 9007199254740993n,
      bytes: new Uint8Array([1, 2, 255]),
      binary: { value: 'AQID', type: 'Binary' },
      boolean: { value: false, type: 'Boolean' },
      dateTime: { value: '2026-01-02T03:04:05Z', type: 'DateTime' },
      double: { value: 42, type: 'Double' },
      guid: { value: '0f8fad5b-d9cb-469f-a165-70867728950e', type: 'Guid' },
      int32: { value: 7, type: 'Int32' },
      int64: { value: '-1', type: 'Int64' },
      string: { value: 'explicit', type: 'String' },
      etag,
      timestamp: '2026-08-24T12:00:00Z',
    })
  })

  test('updates with If-Match, merging with PATCH and replacing with PUT', async () => {
    const requests: { method?: string; ifMatch: string | null }[] = []
    const record = (_url: string, init: RequestInit) => {
      requests.push({ method: init.method, ifMatch: new Headers(init.headers).get('If-Match') })
      return textResponse('', 204)
    }
    const fetcher = createFetchMock([record, record])
    const table = anonymousTable(fetcher)

    await table.updateEntity({ partitionKey: 'pk', rowKey: 'rk', value: 1 }, 'Merge', { etag })
    await table.updateEntity({ partitionKey: 'pk', rowKey: 'rk', value: 2 }, 'Replace')

    expect(requests).toStrictEqual([
      { method: 'PATCH', ifMatch: etag },
      { method: 'PUT', ifMatch: '*' },
    ])
  })

  test('upserts with one unconditional PUT to the escaped entity path', async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        expect(init.method).toBe('PUT')
        expect(new URL(url).pathname).toBe("/mytable(PartitionKey='pk',RowKey='it''s%20%2B1')")
        expect(new Headers(init.headers).has('If-Match')).toBe(false)
        expect(JSON.parse(getBodyString(init.body))).toStrictEqual({
          label: 'item',
          PartitionKey: 'pk',
          RowKey: "it's +1",
        })
        return textResponse('', 204)
      },
    ])

    await anonymousTable(fetcher).upsertEntity({
      partitionKey: 'pk',
      rowKey: "it's +1",
      label: 'item',
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('deletes entities unconditionally and maps a missing entity', async () => {
    const fetcher = createFetchMock([
      (_url, init) => {
        expect(new Headers(init.headers).get('If-Match')).toBe('*')
        return textResponse('', 404)
      },
    ])

    await expect(anonymousTable(fetcher).deleteEntity('pk', 'rk')).resolves.toStrictEqual({
      succeeded: false,
      errorCode: 'ResourceNotFound',
    })
  })

  test('caps the page size to the service limit', async () => {
    const fetcher = createFetchMock([
      (url) => {
        expect(new URL(url).searchParams.get('$top')).toBe('1000')
        return jsonResponse({ value: [{ 'odata.etag': etag, PartitionKey: 'pk', RowKey: 'rk' }] })
      },
    ])

    const pages = await collect(
      anonymousTable(fetcher).listEntities().byPage({ maxPageSize: 2000 }),
    )

    expect(pages).toStrictEqual([
      { value: [{ partitionKey: 'pk', rowKey: 'rk', etag }], continuationToken: undefined },
    ])
  })

  test('follows continuation tokens with the same filter and projection', async () => {
    const queries: Record<string, string>[] = []
    const fetcher = createFetchMock([
      (url) => {
        queries.push(Object.fromEntries(new URL(url).searchParams))
        return Response.json(
          { value: [{ 'odata.etag': etag, value: 1 }] },
          {
            headers: {
              'x-ms-continuation-NextPartitionKey': 'nextPk',
              'x-ms-continuation-NextRowKey': 'nextRk',
            },
          },
        )
      },
      (url) => {
        queries.push(Object.fromEntries(new URL(url).searchParams))
        return jsonResponse({ value: [{ 'odata.etag': etag, value: 2 }] })
      },
    ])

    const pages = await collect(
      anonymousTable(fetcher)
        .listEntities({
          filter: "PartitionKey eq 'pk'",
          select: ['partitionKey', 'rowKey', 'timestamp', 'etag', 'value'],
        })
        .byPage(),
    )

    expect(pages).toStrictEqual([
      {
        value: [{ etag, value: 1 }],
        continuationToken: 'NextPartitionKey=nextPk&NextRowKey=nextRk',
      },
      { value: [{ etag, value: 2 }], continuationToken: undefined },
    ])
    const query = {
      $filter: "PartitionKey eq 'pk'",
      $select: 'PartitionKey,RowKey,Timestamp,value',
    }
    expect(queries).toStrictEqual([
      query,
      { ...query, NextPartitionKey: 'nextPk', NextRowKey: 'nextRk' },
    ])
  })

  test('odata quotes and escapes interpolated literals like the Azure SDK', () => {
    const rowKey = "it's"
    const after = new Date('2026-01-02T03:04:05.678Z')

    expect(
      odata`PartitionKey eq ${'pk'} and RowKey eq '${rowKey}' and Timestamp ge ${after} and n lt ${3}`,
    ).toBe(
      "PartitionKey eq 'pk' and RowKey eq 'it''s' and Timestamp ge datetime'2026-01-02T03:04:05.678Z' and n lt 3",
    )
    expect(odata`${rowKey} eq RowKey`).toBe("it''s eq RowKey")
  })

  test('submits one atomic changeset and returns the ordered sub-responses', async () => {
    let request: { url: string; init: RequestInit } | undefined
    const fetcher = createFetchMock([
      (url, init) => {
        request = { url, init }
        return textResponse(transactionResponseBody([201, 204, 204, 204, 204]), 202)
      },
    ])

    const response = await anonymousTable(fetcher).submitTransaction([
      { action: 'create', entity: { partitionKey: 'p', rowKey: 'r1', count: 1n } },
      { action: 'update', entity: { partitionKey: 'p', rowKey: 'r2', value: 'updated' } },
      {
        action: 'update',
        entity: { partitionKey: 'p', rowKey: 'r5', value: 'merged' },
        mode: 'Merge',
      },
      { action: 'upsert', entity: { partitionKey: 'p', rowKey: 'r3', value: 'upserted' } },
      { action: 'delete', partitionKey: 'p', rowKey: 'r4' },
    ])

    expect(response).toStrictEqual({
      status: 202,
      subResponses: [
        { status: 201 },
        { status: 204 },
        { status: 204 },
        { status: 204 },
        { status: 204 },
      ],
    })
    expect(request?.url).toBe(`${accountUrl}/$batch`)
    const operations = getBodyString(request?.init.body)
      .split('Content-Type: application/http')
      .slice(1)
    expect(operations).toHaveLength(5)
    expect(operations[0]).toContain(`POST ${tableUrl} HTTP/1.1`)
    expect(operations[0]).toContain(
      '{"count":"1","count@odata.type":"Edm.Int64","PartitionKey":"p","RowKey":"r1"}',
    )
    expect(operations[1]).toContain(`PUT ${tableUrl}(PartitionKey='p',RowKey='r2') HTTP/1.1`)
    expect(operations[1]).toContain('If-Match: *')
    expect(operations[2]).toContain(`PATCH ${tableUrl}(PartitionKey='p',RowKey='r5') HTTP/1.1`)
    expect(operations[2]).toContain('If-Match: *')
    expect(operations[3]).toContain(`PUT ${tableUrl}(PartitionKey='p',RowKey='r3') HTTP/1.1`)
    expect(operations[3]).not.toContain('If-Match')
    expect(operations[4]).toContain(`DELETE ${tableUrl}(PartitionKey='p',RowKey='r4') HTTP/1.1`)
    expect(operations[4]).toContain('If-Match: *')
  })

  test('rejects a transaction whose changeset failed', async () => {
    const fetcher = createFetchMock([() => textResponse(transactionResponseBody([409]), 202)])

    await expect(
      anonymousTable(fetcher).submitTransaction([
        { action: 'create', entity: { partitionKey: 'p', rowKey: 'r1' } },
        { action: 'create', entity: { partitionKey: 'p', rowKey: 'r2' } },
      ]),
    ).rejects.toMatchObject({ name: 'AzureRequestError', status: 409 })
  })

  test('rejects a malformed transaction response instead of reporting success', async () => {
    const fetcher = createFetchMock([() => textResponse('', 202)])

    await expect(
      anonymousTable(fetcher).submitTransaction([
        { action: 'delete', partitionKey: 'p', rowKey: 'r' },
      ]),
    ).rejects.toThrow('contained 0 sub-responses; expected 1')
  })
})
