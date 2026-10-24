import { describe, expect, test } from 'vitest'

import { AzureClient } from '../src/client'
import {
  downloadJson,
  downloadText,
  getEntity,
  listEntitiesPage,
  upsertEntity,
  uploadText,
} from '../src/convenience'
import { collect, createFetchMock, getBodyString, jsonResponse, textResponse } from './helpers'

const blobUrl = 'https://example.blob.core.windows.net/container/file.txt'
const tableUrl = 'https://example.table.core.windows.net/mytable'
const etag = `W/"datetime'2026-08-24T12%3A00%3A00.0000000Z'"`

function bearerClient(fetcher: typeof fetch): AzureClient {
  return new AzureClient({
    fetch: fetcher,
    credential: { getAuthorizationHeader: async () => 'Bearer test' },
  })
}

describe('blob helpers', () => {
  test('uploadText sends an authorized block blob PUT', async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        const headers = new Headers(init.headers)
        expect(url).toBe(blobUrl)
        expect(init.method).toBe('PUT')
        expect(getBodyString(init.body)).toBe('hello')
        expect(Object.fromEntries(headers)).toMatchObject({
          authorization: 'Bearer test',
          'content-type': 'text/plain; charset=utf-8',
          'x-ms-blob-type': 'BlockBlob',
          'x-ms-version': '2024-11-04',
        })
        return textResponse('', 201)
      },
    ])

    const response = await uploadText(bearerClient(fetcher), blobUrl, 'hello')

    expect(response.status).toBe(201)
  })

  test('uploadText reports failures with their status', async () => {
    const fetcher = createFetchMock([() => textResponse('failed', 500, 'Server Error')])

    await expect(uploadText(bearerClient(fetcher), blobUrl, 'hello')).rejects.toMatchObject({
      name: 'AzureRequestError',
      status: 500,
    })
  })

  test('downloadText and downloadJson read the blob body', async () => {
    const fetcher = createFetchMock([
      () => textResponse('payload'),
      () => textResponse('{"mode":"on"}'),
      () => textResponse('{"mode":"on"}'),
    ])
    const client = bearerClient(fetcher)

    await expect(downloadText(client, blobUrl)).resolves.toStrictEqual({ text: 'payload' })
    await expect(downloadJson(client, blobUrl)).resolves.toStrictEqual({ value: { mode: 'on' } })
    await expect(
      downloadJson(client, blobUrl, (value) => ({ parsed: value })),
    ).resolves.toStrictEqual({ value: { parsed: { mode: 'on' } } })
  })
})

describe('table helpers', () => {
  test('getEntity sends an authorized OData request', async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        const headers = new Headers(init.headers)
        expect(new URL(url).pathname).toBe("/mytable(PartitionKey='pk',RowKey='rk')")
        expect(headers.get('Authorization')).toBe('Bearer test')
        expect(headers.get('Accept')).toBe('application/json;odata=minimalmetadata')
        return jsonResponse({ 'odata.etag': etag, PartitionKey: 'pk', RowKey: 'rk', value: 'item' })
      },
    ])

    await expect(getEntity(bearerClient(fetcher), tableUrl, 'pk', 'rk')).resolves.toStrictEqual({
      entity: { value: 'item', partitionKey: 'pk', rowKey: 'rk', etag },
    })
  })

  test('upsertEntity sends one authorized PUT', async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        expect(init.method).toBe('PUT')
        expect(new URL(url).pathname).toBe("/mytable(PartitionKey='pk',RowKey='rk')")
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test')
        return textResponse('', 204)
      },
    ])

    await upsertEntity(bearerClient(fetcher), tableUrl, { partitionKey: 'pk', rowKey: 'rk', n: 1 })

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('listEntitiesPage yields entity pages', async () => {
    const fetcher = createFetchMock([
      () => jsonResponse({ value: [{ 'odata.etag': etag, PartitionKey: 'pk', RowKey: 'rk' }] }),
    ])

    const pages = await collect(listEntitiesPage(bearerClient(fetcher), tableUrl))

    expect(pages).toStrictEqual([
      { entities: [{ partitionKey: 'pk', rowKey: 'rk', etag }], continuationToken: undefined },
    ])
  })
})
