import { createHmac } from 'node:crypto'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { StorageSharedKeyCredential } from '../src/storage-shared-key-credential'
import { TableClient } from '../src/table-client'
import { TableServiceClient } from '../src/table-service-client'
import { collect, createFetchMock, getBodyString, jsonResponse, textResponse } from './helpers'

const accountUrl = 'https://myaccount.table.core.windows.net'
const tableUrl = `${accountUrl}/mytable`
const accountKey = 'bXlfYWNjb3VudF9rZXk='
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
        return jsonResponse({ PartitionKey: 'pk', RowKey: 'rk', name: 'item' })
      },
    ])
    const credential = new StorageSharedKeyCredential('myaccount', accountKey)
    const client = new TableServiceClient(accountUrl, credential, { fetch: fetcher })

    const entity = await client.getTableClient('mytable').getEntity('pk', 'rk')

    expect(entity).toStrictEqual({ name: 'item', partitionKey: 'pk', rowKey: 'rk' })
    expect(headers.get('Authorization')).toBe(
      `SharedKeyLite myaccount:${signWithAccountKey(
        "Mon, 24 Aug 2026 12:00:00 GMT\n/myaccount/mytable(PartitionKey='pk',RowKey='rk')",
      )}`,
    )
    expect(headers.get('Accept')).toBe('application/json;odata=nometadata')
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
        jsonResponse({ PartitionKey: 'pk', RowKey: 'rk' }),
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

  test('keeps the service keys when an entity also has lowercase key properties', async () => {
    const fetcher = createFetchMock([
      () => jsonResponse({ PartitionKey: 'pk', RowKey: 'rk', partitionKey: 'x', rowKey: 'y' }),
      (url) => {
        expect(new URL(url).pathname).toBe("/mytable(PartitionKey='pk',RowKey='rk')")
        return textResponse('', 204)
      },
    ])
    const table = anonymousTable(fetcher)

    const entity = await table.getEntity('pk', 'rk')
    expect(entity).toMatchObject({ partitionKey: 'pk', rowKey: 'rk' })
    await table.upsertEntity(entity!)
  })

  test('returns undefined for a missing entity', async () => {
    const fetcher = createFetchMock([() => textResponse('', 404)])

    await expect(anonymousTable(fetcher).getEntity('pk', 'missing')).resolves.toBeUndefined()
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
        return jsonResponse({ value: [{ PartitionKey: 'pk', RowKey: 'rk' }] })
      },
    ])

    const pages = await collect(
      anonymousTable(fetcher).listEntities().byPage({ maxPageSize: 2000 }),
    )

    expect(pages).toStrictEqual([
      { value: [{ partitionKey: 'pk', rowKey: 'rk' }], continuationToken: undefined },
    ])
  })

  test('follows continuation tokens', async () => {
    const fetcher = createFetchMock([
      () =>
        Response.json(
          { value: [{ PartitionKey: 'pk1', RowKey: 'rk1' }] },
          {
            headers: {
              'x-ms-continuation-NextPartitionKey': 'nextPk',
              'x-ms-continuation-NextRowKey': 'nextRk',
            },
          },
        ),
      (url) => {
        const { searchParams } = new URL(url)
        expect(searchParams.get('NextPartitionKey')).toBe('nextPk')
        expect(searchParams.get('NextRowKey')).toBe('nextRk')
        return jsonResponse({ value: [{ PartitionKey: 'pk2', RowKey: 'rk2' }] })
      },
    ])

    const pages = await collect(anonymousTable(fetcher).listEntities().byPage())

    expect(pages).toStrictEqual([
      {
        value: [{ partitionKey: 'pk1', rowKey: 'rk1' }],
        continuationToken: 'NextPartitionKey=nextPk&NextRowKey=nextRk',
      },
      { value: [{ partitionKey: 'pk2', rowKey: 'rk2' }], continuationToken: undefined },
    ])
  })

  test('submits one atomic changeset and returns the ordered sub-responses', async () => {
    let request: { url: string; init: RequestInit } | undefined
    const fetcher = createFetchMock([
      (url, init) => {
        request = { url, init }
        return textResponse(transactionResponseBody([201, 204, 204, 204]), 202)
      },
    ])

    const response = await anonymousTable(fetcher).submitTransaction([
      { action: 'create', entity: { partitionKey: 'p', rowKey: 'r1', value: 'created' } },
      { action: 'update', entity: { partitionKey: 'p', rowKey: 'r2', value: 'updated' } },
      { action: 'upsert', entity: { partitionKey: 'p', rowKey: 'r3', value: 'upserted' } },
      { action: 'delete', partitionKey: 'p', rowKey: 'r4' },
    ])

    expect(response).toStrictEqual({
      status: 202,
      subResponses: [{ status: 201 }, { status: 204 }, { status: 204 }, { status: 204 }],
    })
    expect(request?.url).toBe(`${accountUrl}/$batch`)
    const operations = getBodyString(request?.init.body)
      .split('Content-Type: application/http')
      .slice(1)
    expect(operations).toHaveLength(4)
    expect(operations[0]).toContain(`POST ${tableUrl} HTTP/1.1`)
    expect(operations[0]).toContain('{"value":"created","PartitionKey":"p","RowKey":"r1"}')
    expect(operations[1]).toContain(`PUT ${tableUrl}(PartitionKey='p',RowKey='r2') HTTP/1.1`)
    expect(operations[1]).toContain('If-Match: *')
    expect(operations[2]).toContain(`PUT ${tableUrl}(PartitionKey='p',RowKey='r3') HTTP/1.1`)
    expect(operations[2]).not.toContain('If-Match')
    expect(operations[3]).toContain(`DELETE ${tableUrl}(PartitionKey='p',RowKey='r4') HTTP/1.1`)
    expect(operations[3]).toContain('If-Match: *')
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
