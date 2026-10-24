import { createHash, createHmac } from 'node:crypto'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { AppConfigurationClient } from '../src/app-configuration'
import { collect, createFetchMock, getBodyString, jsonResponse } from './helpers'

const endpoint = 'https://example.azconfig.io'
const bearer = { getAuthorizationHeader: async () => 'Bearer token' }

function settingsPage(body: unknown, syncToken?: string): Response {
  return Response.json(body, {
    headers: {
      'content-type': 'application/vnd.microsoft.appconfig.kvset+json',
      ...(syncToken === undefined ? {} : { 'sync-token': syncToken }),
    },
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AppConfigurationClient', () => {
  test('rejects HTTP endpoints during construction', () => {
    expect(() => new AppConfigurationClient('http://example.azconfig.io', bearer)).toThrow(
      'endpoint must use HTTPS',
    )
    expect(() =>
      AppConfigurationClient.fromConnectionString(
        'Endpoint=http://example.azconfig.io;Id=test;Secret=AQID',
      ),
    ).toThrow('endpoint must use HTTPS')
  })

  test.each([
    { cloud: 'public', url: endpoint, scope: 'https://appconfig.azure.com/.default' },
    {
      cloud: 'US Government',
      url: 'https://example.azconfig.azure.us',
      scope: 'https://appconfig.azure.us/.default',
    },
  ])('requests tokens for the $cloud App Configuration scope', async ({ url, scope }) => {
    const getAuthorizationHeader = vi.fn<(scope?: string | string[]) => Promise<string>>(
      async () => 'Bearer token',
    )
    const fetcher = createFetchMock([() => jsonResponse({ key: 'plain', value: 'value' })])

    await new AppConfigurationClient(
      url,
      { getAuthorizationHeader },
      { fetch: fetcher },
    ).getConfigurationSetting('plain')

    expect(getAuthorizationHeader).toHaveBeenCalledWith(scope)
  })

  test('signs connection string requests with HMAC-SHA256 over the body hash', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-16T12:00:00.000Z'), toFake: ['Date'] })
    const body = '{"key":"app-setting","label":"dev","value":"value"}'
    const contentHash = createHash('sha256').update(body).digest('base64')
    const stringToSign = `PUT\n/kv/app-setting?api-version=2023-11-01&label=dev\nMon, 16 Mar 2026 12:00:00 GMT;example.azconfig.io;${contentHash}`
    const signature = createHmac('sha256', Buffer.from('AQID', 'base64'))
      .update(stringToSign)
      .digest('base64')
    const fetcher = createFetchMock([
      (_url, init) => {
        const headers = new Headers(init.headers)
        expect(getBodyString(init.body)).toBe(body)
        expect(headers.get('x-ms-content-sha256')).toBe(contentHash)
        expect(headers.get('Authorization')).toBe(
          `HMAC-SHA256 Credential=test-id&SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
        )
        return jsonResponse({ key: 'app-setting', label: 'dev', value: 'value' })
      },
    ])

    const client = AppConfigurationClient.fromConnectionString(
      `Endpoint=${endpoint};Id=test-id;Secret=AQID`,
      { fetch: fetcher },
    )

    await client.setConfigurationSetting('app-setting', 'value', { label: 'dev' })
  })

  test('setConfigurationSetting applies the configured prefix and label', async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe(`${endpoint}/kv/app01%3Aplain?api-version=2023-11-01&label=dev`)
        expect(init.method).toBe('PUT')
        expect(new Headers(init.headers).get('Content-Type')).toBe(
          'application/vnd.microsoft.appconfig.kv+json',
        )
        expect(JSON.parse(getBodyString(init.body))).toStrictEqual({
          key: 'app01:plain',
          label: 'dev',
          value: 'value',
          content_type: 'text/plain',
          tags: { env: 'dev' },
        })
        return jsonResponse({
          key: 'app01:plain',
          label: 'dev',
          value: 'value',
          content_type: 'text/plain',
          last_modified: '2026-03-16T12:30:00.000Z',
          locked: true,
          etag: '"etag-1"',
          tags: { env: 'dev' },
        })
      },
    ])
    const client = new AppConfigurationClient(endpoint, bearer, {
      fetch: fetcher,
      prefix: 'app01',
      label: 'dev',
    })

    const setting = await client.setConfigurationSetting('plain', 'value', {
      contentType: 'text/plain',
      tags: { env: 'dev' },
    })

    expect(setting).toStrictEqual({
      key: 'plain',
      label: 'dev',
      value: 'value',
      contentType: 'text/plain',
      lastModified: new Date('2026-03-16T12:30:00.000Z'),
      isReadOnly: true,
      etag: '"etag-1"',
      tags: { env: 'dev' },
    })
  })

  test('setConfigurationSetting encodes special key characters and keeps unicode values', async () => {
    const key = String.raw`Titles/Welcome, Draft*\日本語`
    const value = 'Line 1\nGrüße 🚀'
    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe(
          `${endpoint}/kv/TestApp%3ATitles%2FWelcome%2C%20Draft*%5C%E6%97%A5%E6%9C%AC%E8%AA%9E?api-version=2023-11-01`,
        )
        expect(JSON.parse(getBodyString(init.body))).toMatchObject({ value })
        return jsonResponse({ key: `TestApp:${key}`, value })
      },
    ])
    const client = new AppConfigurationClient(endpoint, bearer, {
      fetch: fetcher,
      prefix: 'TestApp',
    })

    await expect(client.setConfigurationSetting(key, value)).resolves.toMatchObject({ key, value })
  })

  test('deleteConfigurationSetting returns undefined on a 204 response', async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe(`${endpoint}/kv/plain?api-version=2023-11-01`)
        expect(init.method).toBe('DELETE')
        return new Response(null, { status: 204 })
      },
    ])
    const client = new AppConfigurationClient(endpoint, bearer, { fetch: fetcher })

    await expect(client.deleteConfigurationSetting('plain')).resolves.toBeUndefined()
  })

  test('lists settings by prefix and unlabeled filter across continuation pages', async () => {
    const fetcher = createFetchMock([
      (url) => {
        expect(url).toBe(`${endpoint}/kv?api-version=2023-11-01&key=app01%3A*&label=%00`)
        return settingsPage({
          items: [{ key: 'app01:one', value: '1' }],
          '@nextLink': '/kv?after=next-token&api-version=2023-11-01&key=app01:*&label=%00',
        })
      },
      (url) => {
        expect(url).toBe(
          `${endpoint}/kv?after=next-token&api-version=2023-11-01&key=app01%3A*&label=%00`,
        )
        return settingsPage({ items: [{ key: 'app01:two', value: '2' }] })
      },
    ])
    const client = new AppConfigurationClient(endpoint, bearer, {
      fetch: fetcher,
      prefix: 'app01',
      label: null,
    })

    const settings = await collect(client.listConfigurationSettings())

    expect(settings.map(({ key }) => key)).toStrictEqual(['one', 'two'])
  })

  test('escapes reserved characters in generated key and label filters', async () => {
    const fetcher = createFetchMock([
      (url) => {
        expect(url).toBe(
          `${endpoint}/kv?api-version=2023-11-01&key=TestApp%3AWeb%5C%2CBlue%5C*%5C%5CTitles%3A*&label=Prod%5C%2CEU%5C*%5C%5C`,
        )
        return settingsPage({ items: [] })
      },
    ])
    const client = new AppConfigurationClient(endpoint, bearer, {
      fetch: fetcher,
      prefix: String.raw`TestApp:Web,Blue*\Titles`,
      label: 'Prod,EU*\\',
    })

    await expect(collect(client.listConfigurationSettings().byPage())).resolves.toHaveLength(1)
  })

  test('sends the highest sync token per ID and ignores malformed ones', async () => {
    const responseTokens = [
      'a=MQ==;sn=5,b=Mg==;sn=2',
      'a=bG93;sn=4,b=ZXF1YWw=;sn=2,not-a-token',
      'a=aGlnaA==;sn=6,c=Mw==;sn=1',
      undefined,
    ]
    const expectedRequestTokens = [
      null,
      'a=MQ==,b=Mg==',
      'a=MQ==,b=Mg==',
      'a=aGlnaA==,b=Mg==,c=Mw==',
    ]
    const fetcher = createFetchMock(
      responseTokens.map((syncToken, index) => (_url, init) => {
        expect(new Headers(init.headers).get('Sync-Token')).toBe(expectedRequestTokens[index])
        return Response.json(
          { key: 'plain', value: 'value' },
          { headers: syncToken === undefined ? {} : { 'sync-token': syncToken } },
        )
      }),
    )
    const client = new AppConfigurationClient(endpoint, bearer, { fetch: fetcher })

    await client.getConfigurationSetting('plain')
    await client.getConfigurationSetting('plain')
    await client.getConfigurationSetting('plain')
    await client.getConfigurationSetting('plain')

    expect(fetcher).toHaveBeenCalledTimes(responseTokens.length)
  })

  test('reports service errors with status and problem details', async () => {
    const fetcher = createFetchMock([
      () =>
        Response.json(
          { title: 'Not Found', name: 'ResourceNotFound', detail: 'The key was not found.' },
          { status: 404, statusText: 'Not Found' },
        ),
    ])
    const client = new AppConfigurationClient(endpoint, bearer, { fetch: fetcher })

    const request = client.getConfigurationSetting('missing')

    await expect(request).rejects.toThrow('The key was not found.')
    await expect(request).rejects.toMatchObject({
      name: 'AzureRequestError',
      status: 404,
      errorCode: 'ResourceNotFound',
    })
  })
})
