import { createHmac } from 'node:crypto'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { BlobServiceClient } from '../src/blob-service-client'
import type { ContainerClient } from '../src/container-client'
import { StorageSharedKeyCredential } from '../src/storage-shared-key-credential'
import { collect, createFetchMock, getBodyString, textResponse } from './helpers'

const accountUrl = 'https://myaccount.blob.core.windows.net'
const accountKey = 'bXlfYWNjb3VudF9rZXk='
const signWithAccountKey = (stringToSign: string) =>
  createHmac('sha256', Buffer.from(accountKey, 'base64')).update(stringToSign).digest('base64')
const emptyListing =
  '<EnumerationResults><Blobs></Blobs><NextMarker></NextMarker></EnumerationResults>'

function anonymousClient(fetcher: typeof fetch): BlobServiceClient {
  return new BlobServiceClient(accountUrl, undefined, { fetch: fetcher })
}

function blobListing(names: string[], nextMarker = ''): string {
  const blobs = names.map((name) => `<Blob>${name}<Properties /></Blob>`).join('')
  return `<EnumerationResults><Blobs>${blobs}</Blobs><NextMarker>${nextMarker}</NextMarker></EnumerationResults>`
}

afterEach(() => {
  vi.useRealTimers()
})

describe('StorageSharedKeyCredential', () => {
  test('signs with HMAC-SHA256 of the base64 account key', async () => {
    const credential = new StorageSharedKeyCredential('myaccount', accountKey)

    await expect(credential.computeHMACSHA256('string-to-sign')).resolves.toBe(
      'YVUZyGQhQYkINoGdVZFuZ7o0Vd6Ryuoso8VGjRwqwR0=',
    )
  })
})

describe('BlobServiceClient URLs', () => {
  test.each([
    {
      kind: 'account key',
      connectionString: `DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=${accountKey};EndpointSuffix=core.windows.net`,
      url: 'https://myaccount.blob.core.windows.net/',
    },
    {
      kind: 'SAS',
      connectionString: `BlobEndpoint=${accountUrl}/;SharedAccessSignature=?sp=r&sv=2024-11-04`,
      url: 'https://myaccount.blob.core.windows.net/?sp=r&sv=2024-11-04',
    },
    {
      kind: 'development storage',
      connectionString: `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${accountKey};BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1/`,
      url: 'http://127.0.0.1:10000/devstoreaccount1',
    },
  ])('builds the service URL from $kind connection strings', ({ connectionString, url }) => {
    expect(BlobServiceClient.fromConnectionString(connectionString).url).toBe(url)
  })

  test('keeps the SAS query when the URL path ends with a slash', () => {
    expect(new BlobServiceClient(`${accountUrl}/sub/?sv=1&sig=x`).url).toBe(
      `${accountUrl}/sub?sv=1&sig=x`,
    )
  })
})

describe('Shared Key requests', () => {
  test.each([
    {
      operation: 'container create without a body',
      send: async (container: ContainerClient) => await container.createIfNotExists(),
      contentLength: null,
      signedLines: ['PUT', '', '', '', '', ''],
      signedHeaders: [],
      resource: '/myaccount/container\nrestype:container',
    },
    {
      operation: 'empty upload',
      send: async (container: ContainerClient) =>
        await container.getBlockBlobClient('a b.txt').upload(''),
      contentLength: '0',
      signedLines: ['PUT', '', '', '', '', 'application/octet-stream'],
      signedHeaders: ['x-ms-blob-type:BlockBlob'],
      resource: '/myaccount/container/a%20b.txt',
    },
    {
      operation: 'UTF-8 upload',
      send: async (container: ContainerClient) =>
        await container.getBlockBlobClient('a b.txt').upload('héllo'),
      contentLength: '6',
      signedLines: ['PUT', '', '', '6', '', 'application/octet-stream'],
      signedHeaders: ['x-ms-blob-type:BlockBlob'],
      resource: '/myaccount/container/a%20b.txt',
    },
  ])(
    'signs a $operation',
    async ({ send, contentLength, signedLines, signedHeaders, resource }) => {
      vi.useFakeTimers({ now: new Date('2026-08-24T12:00:00Z'), toFake: ['Date'] })
      let headers = new Headers()
      const fetcher = createFetchMock([
        (_url, init) => {
          headers = new Headers(init.headers)
          return textResponse('', 201)
        },
      ])
      const credential = new StorageSharedKeyCredential('myaccount', accountKey)
      const client = new BlobServiceClient(accountUrl, credential, { fetch: fetcher })

      await send(client.getContainerClient('container'))

      const stringToSign = [
        ...signedLines,
        '',
        '',
        '',
        '',
        '',
        '',
        ...signedHeaders,
        'x-ms-date:Mon, 24 Aug 2026 12:00:00 GMT',
        'x-ms-version:2024-11-04',
        resource,
      ].join('\n')
      expect(headers.get('Content-Length')).toBe(contentLength)
      expect(headers.get('Authorization')).toBe(
        `SharedKey myaccount:${signWithAccountKey(stringToSign)}`,
      )
    },
  )
})

describe('BlobServiceClient.generateAccountSasUrl', () => {
  test('signs the canonical Account SAS fields', async () => {
    const credential = new StorageSharedKeyCredential('myaccount', accountKey)
    const client = new BlobServiceClient(accountUrl, credential)

    const sasUrl = await client.generateAccountSasUrl(new Date('2030-01-01T00:00:00.000Z'), {
      permissions: 'lwr',
      services: 'fb',
      resourceTypes: 'ocs',
      protocol: 'https,http',
    })

    expect(Object.fromEntries(new URL(sasUrl).searchParams)).toStrictEqual({
      sp: 'rwl',
      ss: 'bf',
      srt: 'sco',
      sv: '2024-11-04',
      se: '2030-01-01T00:00:00Z',
      spr: 'https,http',
      sig: signWithAccountKey(
        'myaccount\nrwl\nbf\nsco\n\n2030-01-01T00:00:00Z\n\nhttps,http\n2024-11-04\n\n',
      ),
    })
  })

  test('requires a shared key credential', async () => {
    await expect(
      new BlobServiceClient(accountUrl).generateAccountSasUrl(undefined, { permissions: 'r' }),
    ).rejects.toThrow('requires a StorageSharedKeyCredential')
  })

  test.each([
    { input: 'an invalid expiry', expiry: new Date(Number.NaN), options: {}, error: 'valid date' },
    {
      input: 'an invalid permission',
      expiry: undefined,
      options: { permissions: 'rq' },
      error: 'permissions character: q',
    },
    {
      input: 'empty services',
      expiry: undefined,
      options: { permissions: 'r', services: '' },
      error: 'services cannot be empty',
    },
  ])('rejects $input', async ({ expiry, options, error }) => {
    const credential = new StorageSharedKeyCredential('myaccount', accountKey)

    await expect(
      new BlobServiceClient(accountUrl, credential).generateAccountSasUrl(expiry, options),
    ).rejects.toThrow(error)
  })
})

describe('BlockBlobClient', () => {
  test('download requests the byte range', async () => {
    const fetcher = createFetchMock([
      (_url, init) => {
        expect(new Headers(init.headers).get('Range')).toBe('bytes=2-4')
        return textResponse('llo', 206)
      },
    ])
    const blob = anonymousClient(fetcher).getContainerClient('container').getBlockBlobClient('a')

    const response = await blob.download(2, 3)

    await expect(response.text()).resolves.toBe('llo')
  })

  test.each([
    { status: 202, result: { succeeded: true } },
    { status: 404, result: { succeeded: false, errorCode: 'BlobNotFound' } },
  ])('maps a $status delete response', async ({ status, result }) => {
    const fetcher = createFetchMock([() => textResponse('', status)])
    const blob = anonymousClient(fetcher).getContainerClient('container').getBlockBlobClient('a')

    await expect(blob.deleteIfExists()).resolves.toStrictEqual(result)
  })

  test('reads metadata and timestamps from blob properties', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const fetcher = createFetchMock([
      () =>
        textResponse('', 200, 'OK', {
          etag: '"etag"',
          'last-modified': now.toUTCString(),
          'x-ms-meta-foo': 'bar',
          'x-ms-creation-time': now.toUTCString(),
        }),
    ])
    const blob = anonymousClient(fetcher).getContainerClient('container').getBlockBlobClient('a')

    await expect(blob.getProperties()).resolves.toStrictEqual({
      etag: '"etag"',
      lastModified: now,
      lastAccessed: undefined,
      createdOn: now,
      metadata: { foo: 'bar' },
    })
  })

  test('reports failed requests with status and service error code', async () => {
    const fetcher = createFetchMock([
      () =>
        textResponse('', 403, 'Forbidden', {
          'x-ms-error-code': 'AuthorizationPermissionMismatch',
        }),
    ])
    const blob = anonymousClient(fetcher).getContainerClient('container').getBlockBlobClient('a')

    await expect(blob.upload('data')).rejects.toMatchObject({
      name: 'AzureRequestError',
      status: 403,
      errorCode: 'AuthorizationPermissionMismatch',
    })
  })
})

describe('ContainerClient.listBlobsFlat', () => {
  test('caps maxPageSize to the service limit', async () => {
    const fetcher = createFetchMock([
      (url) => {
        expect(new URL(url).searchParams.get('maxresults')).toBe('5000')
        return textResponse(emptyListing)
      },
    ])

    const pages = anonymousClient(fetcher)
      .getContainerClient('container')
      .listBlobsFlat()
      .byPage({ maxPageSize: 10_000 })

    await expect(collect(pages)).resolves.toHaveLength(1)
  })

  test('follows continuation markers', async () => {
    const urls: URL[] = []
    const fetcher = createFetchMock([
      (url) => {
        urls.push(new URL(url))
        return textResponse(blobListing(['<Name>first</Name>'], 'marker'))
      },
      (url) => {
        urls.push(new URL(url))
        return textResponse(blobListing(['<Name>second</Name>']))
      },
    ])

    const pages = await collect(
      anonymousClient(fetcher).getContainerClient('container').listBlobsFlat().byPage(),
    )

    expect(pages).toStrictEqual([
      { segment: { blobItems: [{ name: 'first' }] }, continuationToken: 'marker' },
      { segment: { blobItems: [{ name: 'second' }] }, continuationToken: '' },
    ])
    expect(Object.fromEntries(urls[0]?.searchParams ?? [])).toStrictEqual({
      restype: 'container',
      comp: 'list',
    })
    expect(urls[1]?.searchParams.get('marker')).toBe('marker')
  })

  test('starts from an explicit continuation token', async () => {
    const fetcher = createFetchMock([
      (url) => {
        expect(new URL(url).searchParams.get('marker')).toBe('start token')
        return textResponse(emptyListing)
      },
    ])

    const pages = anonymousClient(fetcher)
      .getContainerClient('container')
      .listBlobsFlat()
      .byPage({ continuationToken: 'start token' })

    await expect(collect(pages)).resolves.toHaveLength(1)
  })

  test('decodes XML entities and percent-encoded names', async () => {
    const fetcher = createFetchMock([
      () =>
        textResponse(
          blobListing([
            '<Name>a &lt;b&gt; &amp;lt; &#233;&#x1F600;</Name>',
            '<Name Encoded="true">c%EF%BF%BE</Name>',
          ]),
        ),
    ])

    const [page] = await collect(
      anonymousClient(fetcher).getContainerClient('container').listBlobsFlat().byPage(),
    )

    expect(page?.segment.blobItems.map(({ name }) => name)).toStrictEqual(['a <b> &lt; é😀', 'c￾'])
  })
})

describe('BlobServiceClient.listContainers', () => {
  test('lists container names with the account list query', async () => {
    const fetcher = createFetchMock([
      (url) => {
        expect(Object.fromEntries(new URL(url).searchParams)).toStrictEqual({ comp: 'list' })
        return textResponse(
          '<EnumerationResults><Containers><Container><Name>one</Name></Container></Containers><NextMarker /></EnumerationResults>',
        )
      },
    ])

    const pages = await collect(anonymousClient(fetcher).listContainers().byPage())

    expect(pages).toStrictEqual([
      { segment: { containerItems: [{ name: 'one' }] }, continuationToken: '' },
    ])
  })
})

describe('BlobBatchClient.deleteBlobs', () => {
  test('sends authorized sub-requests and maps sub-responses by Content-ID', async () => {
    const responseBody = [
      '--batchresponse_1',
      'Content-Type: application/http',
      'Content-ID: 1',
      '',
      'HTTP/1.1 404 The specified blob does not exist.',
      'x-ms-error-code: BlobNotFound',
      '',
      '--batchresponse_1',
      'Content-Type: application/http',
      'Content-ID: 0',
      '',
      'HTTP/1.1 202 Accepted',
      '',
      '--batchresponse_1--',
    ].join('\r\n')
    let request: { url: string; init: RequestInit } | undefined
    const fetcher = createFetchMock([
      (url, init) => {
        request = { url, init }
        return textResponse(responseBody, 202, 'Accepted', {
          'content-type': 'multipart/mixed; boundary=batchresponse_1',
        })
      },
    ])
    const credential = { getAuthorizationHeader: async () => 'Bearer batch-token' }
    const client = new BlobServiceClient(accountUrl, credential, { fetch: fetcher })

    const response = await client
      .getBlobBatchClient()
      .deleteBlobs([`${accountUrl}/container/one.txt`, `${accountUrl}/container/two.txt`], {
        deleteSnapshots: 'include',
      })

    expect(response).toStrictEqual({
      subResponses: [
        { status: 202, errorCode: undefined },
        { status: 404, errorCode: 'BlobNotFound' },
      ],
      subResponsesSucceededCount: 1,
      subResponsesFailedCount: 1,
    })
    expect(new URL(request?.url ?? '').searchParams.get('comp')).toBe('batch')
    const body = getBodyString(request?.init.body)
    for (const [index, path] of ['/container/one.txt', '/container/two.txt'].entries()) {
      expect(body).toContain(`Content-ID: ${index}\r\n\r\nDELETE ${path} HTTP/1.1\r\n`)
    }
    expect(body.match(/authorization: Bearer batch-token/gu)).toHaveLength(2)
    expect(body.match(/x-ms-delete-snapshots: include/gu)).toHaveLength(2)
  })
})
