import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { getManagedIdentityToken } from '../src/managed-identity'
import { TokenRequestError } from '../src/token-request-error'
import { TokenUnavailableError } from '../src/token-unavailable-error'
import {
  clearCredentialEnvironment,
  createFetchMock,
  getBodyString,
  jsonResponse,
  rejectionOf,
} from './helpers'
import type { FetchHandler } from './helpers'

const scope = 'https://vault.azure.net/.default'
const tokenResponse = () => jsonResponse({ access_token: 'mi-token', expires_in: 600 })
const probeResponse = () => jsonResponse({ error: 'invalid_request' }, 400)
const unavailable = () => jsonResponse({ error: 'unavailable' }, 503)

function gaps(times: number[]): number[] {
  return times.slice(1).map((time, index) => time - (times[index] ?? 0))
}

function useAppService(): void {
  vi.stubEnv('IDENTITY_ENDPOINT', 'https://appservice.azurewebsites.net/identity')
  vi.stubEnv('IDENTITY_HEADER', 'app-header-token')
}

/** IMDS answers the probe, then `failures` token responses with `status`, then a token. */
function imds(status: number, failures: number): { fetch: typeof fetch; times: number[] } {
  const times: number[] = []
  const fail: FetchHandler = () => {
    times.push(Date.now())
    return jsonResponse({ error: 'unavailable' }, status)
  }
  const succeed: FetchHandler = () => {
    times.push(Date.now())
    return tokenResponse()
  }
  return {
    fetch: createFetchMock([
      probeResponse,
      ...Array.from({ length: failures }, () => fail),
      succeed,
    ]),
    times,
  }
}

describe('getManagedIdentityToken', () => {
  beforeEach(() => {
    clearCredentialEnvironment()
  })

  test('rejects missing or non-default scope', async () => {
    const fetchMock = createFetchMock([])

    await expect(
      getManagedIdentityToken({ scope: 'https://vault.azure.net', fetch: fetchMock }),
    ).rejects.toThrow('Scope must end with /.default')
    await expect(
      getManagedIdentityToken({
        scope: `${scope} https://graph.microsoft.com/.default`,
        fetch: fetchMock,
      }),
    ).rejects.toThrow('Managed identity requires exactly one scope')
  })

  test('rejects more than one identity selector', async () => {
    await expect(
      getManagedIdentityToken({
        scope,
        clientId: 'client',
        resourceId: 'resource',
        fetch: createFetchMock([]),
      }),
    ).rejects.toThrow('Specify at most one of clientId, objectId, or resourceId')
  })

  test('requests an App Service token with query and headers', async () => {
    useAppService()
    const fetchMock = createFetchMock([
      (url, init) => {
        const requestUrl = new URL(url)
        const headers = new Headers(init.headers)
        expect(requestUrl.origin + requestUrl.pathname).toBe(
          'https://appservice.azurewebsites.net/identity',
        )
        expect(Object.fromEntries(requestUrl.searchParams)).toStrictEqual({
          'api-version': '2019-08-01',
          resource: 'https://vault.azure.net',
          client_id: 'my-client',
        })
        expect(headers.get('X-IDENTITY-HEADER')).toBe('app-header-token')
        return tokenResponse()
      },
    ])

    const token = await getManagedIdentityToken({ scope, clientId: 'my-client', fetch: fetchMock })

    expect(token).toMatchObject({ token: 'mi-token', tokenType: 'Bearer' })
  })

  test.each([
    { source: 'App Service', setup: useAppService, parameter: 'mi_res_id' },
    { source: 'IMDS', setup: () => {}, parameter: 'msi_res_id' },
  ])('sends the resource ID selector as $parameter to $source', async ({ setup, parameter }) => {
    setup()
    let tokenUrl: URL | undefined
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      tokenUrl = new URL(new Request(input).url)
      return tokenResponse()
    })

    await getManagedIdentityToken({
      scope,
      resourceId: '/subscriptions/s/identity',
      fetch: fetchMock,
    })

    expect(tokenUrl?.searchParams.get(parameter)).toBe('/subscriptions/s/identity')
  })

  test('requests a Cloud Shell token with a form POST and rejects identity selectors', async () => {
    vi.stubEnv('MSI_ENDPOINT', 'http://localhost:8080/msi/token')

    await expect(
      getManagedIdentityToken({ scope, clientId: 'my-client', fetch: createFetchMock([]) }),
    ).rejects.toBeInstanceOf(TokenUnavailableError)

    const fetchMock = createFetchMock([
      (url, init) => {
        expect(url).toBe('http://localhost:8080/msi/token')
        expect(init.method).toBe('POST')
        expect(new Headers(init.headers).get('Metadata')).toBe('true')
        expect(Object.fromEntries(new URLSearchParams(getBodyString(init.body)))).toStrictEqual({
          resource: 'https://vault.azure.net',
          'api-version': '2017-09-01',
        })
        return tokenResponse()
      },
    ])

    await expect(getManagedIdentityToken({ scope, fetch: fetchMock })).resolves.toMatchObject({
      token: 'mi-token',
    })
  })

  test('probes IMDS before requesting the token', async () => {
    const fetchMock = createFetchMock([
      (url, init) => {
        expect(url).toBe('http://169.254.169.254/metadata/identity/oauth2/token')
        expect(new Headers(init.headers).has('Metadata')).toBe(false)
        expect(init.signal).toBeInstanceOf(AbortSignal)
        return new Response('missing metadata header', { status: 400 })
      },
      (url, init) => {
        const requestUrl = new URL(url)
        expect(requestUrl.searchParams.get('api-version')).toBe('2018-02-01')
        expect(requestUrl.searchParams.get('object_id')).toBe('object-1')
        expect(new Headers(init.headers).get('Metadata')).toBe('true')
        // Only the probe is time-limited; issuing the first token can take longer.
        expect(init.signal).toBeUndefined()
        return tokenResponse()
      },
    ])

    const token = await getManagedIdentityToken({ scope, objectId: 'object-1', fetch: fetchMock })

    expect(token.token).toBe('mi-token')
  })

  test('reports IMDS as unavailable when the endpoint cannot be reached', async () => {
    const fetchMock = createFetchMock([
      () => {
        throw new TypeError('fetch failed')
      },
    ])

    await expect(getManagedIdentityToken({ scope, fetch: fetchMock })).rejects.toMatchObject({
      name: 'TokenUnavailableError',
      message: 'IMDS endpoint unavailable',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('reports a token response that fails mid-body as unavailable', async () => {
    vi.stubEnv('MSI_ENDPOINT', 'http://localhost:8080/msi/token')
    const fetchMock = createFetchMock([
      () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.error(new TypeError('terminated'))
            },
          }),
        ),
    ])

    await expect(getManagedIdentityToken({ scope, fetch: fetchMock })).rejects.toMatchObject({
      name: 'TokenUnavailableError',
    })
  })

  test.each([
    { status: 400, name: 'TokenRequestError' },
    { status: 503, name: 'TokenUnavailableError' },
  ])('maps a $status token response to $name', async ({ status, name }) => {
    vi.stubEnv('MSI_ENDPOINT', 'http://localhost:8080/msi/token')
    const fetchMock = createFetchMock([() => jsonResponse({ error: 'invalid_resource' }, status)])

    await expect(
      getManagedIdentityToken({ scope, retryOptions: { maxRetries: 0 }, fetch: fetchMock }),
    ).rejects.toMatchObject({ name })
  })
})

describe('managed identity retries', () => {
  beforeEach(() => {
    clearCredentialEnvironment()
    vi.useFakeTimers({ now: 0 })
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('retries IMDS 410 five times from 3 s, waiting at least 70 s in total', async () => {
    const { fetch, times } = imds(410, 5)

    const token = getManagedIdentityToken({ scope, fetch })
    await vi.runAllTimersAsync()

    await expect(token).resolves.toMatchObject({ token: 'mi-token' })
    expect(gaps(times)).toStrictEqual([2400, 4800, 9600, 19_200, 38_400])
    expect(times.at(-1)).toBeGreaterThanOrEqual(70_000)
  })

  test('retries IMDS 404 five times from 800 ms and then reports the response', async () => {
    const { fetch, times } = imds(404, 6)

    const failure = rejectionOf(getManagedIdentityToken({ scope, fetch }))
    await vi.runAllTimersAsync()

    await expect(failure).resolves.toBeInstanceOf(TokenRequestError)
    expect(gaps(times.slice(0, 6))).toStrictEqual([640, 1280, 2560, 5120, 10_240])
    expect(fetch).toHaveBeenCalledTimes(7)
  })

  test('does not retry the IMDS probe', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('fetch failed')
    })

    await expect(getManagedIdentityToken({ scope, fetch })).rejects.toBeInstanceOf(
      TokenUnavailableError,
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('uses the default retries for App Service and reports a lasting 5xx as unavailable', async () => {
    useAppService()
    const fetch = createFetchMock([unavailable, unavailable, unavailable, unavailable])

    const failure = rejectionOf(getManagedIdentityToken({ scope, fetch }))
    await vi.runAllTimersAsync()

    await expect(failure).resolves.toBeInstanceOf(TokenUnavailableError)
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})
