import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { BlockBlobClient } from '../src/block-blob-client'
import { AzureClient } from '../src/client'
import { ClientSecretCredential } from '../src/client-secret-credential'
import type { RetryContext, RetryOptions } from '../src/internal/request-core'
import { KeyVaultSecretClient } from '../src/keyvault-secrets'
import { getServicePrincipalToken } from '../src/service-principal'
import { TableClient } from '../src/table-client'
import { TokenRequestError } from '../src/token-request-error'
import { createFetchMock, getBodyString, jsonResponse, rejectionOf, textResponse } from './helpers'
import type { FetchHandler } from './helpers'

const url = 'https://example.vault.azure.net/secrets/name'
const credential = { getAuthorizationHeader: async () => 'Bearer test' }
const ok = () => textResponse('ok')
const tokenUnavailable = () => jsonResponse({ error: 'temporarily_unavailable' }, 503)

/** Answers each call with the next status and records when it arrived. */
function statuses(...codes: number[]): { fetch: typeof globalThis.fetch; times: number[] } {
  const times: number[] = []
  const handlers = codes.map((status): FetchHandler => () => {
    times.push(Date.now())
    return textResponse(`status ${status}`, status)
  })
  return { fetch: createFetchMock(handlers), times }
}

function withHeaders(status: number, headers: HeadersInit): FetchHandler {
  return () => textResponse('', status, '', headers)
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((time, index) => time - (times[index] ?? 0))
}

/** Sends one request through an AzureClient and runs every pending wait. */
async function send(
  fetch: typeof globalThis.fetch,
  retryOptions?: RetryOptions,
  init: RequestInit = {},
): Promise<Response> {
  const response = new AzureClient({ credential, retryOptions, fetch }).fetch(url, init)
  await vi.runAllTimersAsync()
  return await response
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('default retries', () => {
  test.each([408, 429, 500, 502, 503, 504])('retries %i up to 3 times', async (status) => {
    const { fetch } = statuses(status, status, status, status)

    const response = await send(fetch)

    expect(response.status).toBe(status)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  test.each([400, 401, 404, 409, 501])('does not retry %i', async (status) => {
    const { fetch } = statuses(status)

    await expect(send(fetch)).resolves.toMatchObject({ status })
  })

  test('retries network errors and returns the later response', async () => {
    const fetch = createFetchMock([
      () => {
        throw new TypeError('fetch failed')
      },
      ok,
    ])

    await expect(send(fetch)).resolves.toMatchObject({ status: 200 })
  })

  test('rethrows the last network error when retries run out', async () => {
    const failure = new TypeError('fetch failed')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw failure
    })

    const rejection = rejectionOf(new AzureClient({ credential, fetch }).fetch(url))
    await vi.runAllTimersAsync()

    await expect(rejection).resolves.toBe(failure)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  test('waits between 80% and 100% of a backoff that doubles from 1 s', async () => {
    const lower = statuses(503, 503, 503, 200)
    await send(lower.fetch)
    vi.mocked(Math.random).mockReturnValue(1)
    const upper = statuses(503, 503, 503, 200)
    await send(upper.fetch)

    expect(gaps(lower.times)).toStrictEqual([800, 1600, 3200])
    expect(gaps(upper.times)).toStrictEqual([1000, 2000, 4000])
  })

  test('caps the backoff at maxRetryDelayInMs', async () => {
    vi.mocked(Math.random).mockReturnValue(1)
    const { fetch, times } = statuses(503, 503, 503, 200)

    await send(fetch, { maxRetryDelayInMs: 1500 })

    expect(gaps(times)).toStrictEqual([1000, 1500, 1500])
  })

  test('releases discarded bodies and leaves the final body readable', async () => {
    let cancelled = 0
    const discarded = () =>
      new Response(
        new ReadableStream({
          cancel: () => {
            cancelled += 1
          },
        }),
        { status: 503 },
      )
    const fetch = createFetchMock([discarded, discarded, () => textResponse('final', 503)])

    const response = await send(fetch, { maxRetries: 2 })

    expect(cancelled).toBe(2)
    await expect(response.text()).resolves.toBe('final')
  })
})

describe('wait hints', () => {
  test.each([
    ['retry-after-ms', '1500', 1500],
    ['x-ms-retry-after-ms', '2500', 2500],
    ['retry-after', '3', 3000],
  ])('waits for %s: %s', async (name, value, expected) => {
    const times: number[] = []
    const fetch = createFetchMock([
      () => {
        times.push(Date.now())
        return textResponse('', 503, '', { [name]: value })
      },
      () => {
        times.push(Date.now())
        return ok()
      },
    ])

    await send(fetch)

    expect(gaps(times)).toStrictEqual([expected])
  })

  test('waits until a Retry-After date and not at all for a past one', async () => {
    vi.setSystemTime(5000)
    const times: number[] = []
    const record =
      (status: number, headers: HeadersInit = {}): FetchHandler =>
      () => {
        times.push(Date.now())
        return textResponse('', status, '', headers)
      }
    const fetch = createFetchMock([
      record(503, { 'retry-after': new Date(10_000).toUTCString() }),
      record(503, { 'retry-after': new Date(0).toUTCString() }),
      record(200),
    ])

    await send(fetch)

    expect(times).toStrictEqual([5000, 10_000, 10_000])
  })

  test.each([
    [{ 'retry-after-ms': '100', 'x-ms-retry-after-ms': '200', 'retry-after': '3' }, 100],
    [{ 'retry-after-ms': 'soon', 'x-ms-retry-after-ms': '200', 'retry-after': '3' }, 200],
    [{ 'retry-after-ms': '-1', 'retry-after': '3' }, 3000],
    [{ 'retry-after': '-3' }, undefined],
    [{ 'retry-after': 'later' }, undefined],
  ])('reads the first valid wait hint of %o', async (headers, expected) => {
    const hints: (number | undefined)[] = []

    await send(createFetchMock([withHeaders(503, headers)]), {
      shouldRetry: ({ retryAfterInMs }) => {
        hints.push(retryAfterInMs)
        return false
      },
    })

    expect(hints).toStrictEqual([expected])
  })

  test('does not retry a non-retryable response because it has a hint', async () => {
    const fetch = createFetchMock([withHeaders(400, { 'retry-after-ms': '10' })])

    await expect(send(fetch)).resolves.toMatchObject({ status: 400 })
  })

  test('returns the response unchanged when the hint exceeds the maximum delay', async () => {
    const fetch = createFetchMock([() => textResponse('busy', 429, '', { 'retry-after': '61' })])

    const response = await send(fetch)

    expect(response.status).toBe(429)
    await expect(response.text()).resolves.toBe('busy')
  })
})

describe('retryOptions', () => {
  test('maxRetries limits the retries and 0 disables them', async () => {
    const once = statuses(503, 503, 503)
    await send(once.fetch, { maxRetries: 1 })
    const never = statuses(503, 503)
    await send(never.fetch, { maxRetries: 0 })

    expect(once.fetch).toHaveBeenCalledTimes(2)
    expect(never.fetch).toHaveBeenCalledTimes(1)
  })

  test('retryDelayInMs sets the backoff base and retryableStatuses the statuses', async () => {
    const { fetch, times } = statuses(404, 404, 503)

    const response = await send(fetch, { retryDelayInMs: 100, retryableStatuses: [404] })

    expect(response.status).toBe(503)
    expect(gaps(times)).toStrictEqual([80, 160])
  })

  test('shouldRetry sees the attempt, response, error and hint and can fall back to the default', async () => {
    const contexts: RetryContext[] = []
    const failure = new TypeError('fetch failed')
    const fetch = createFetchMock([
      withHeaders(400, { 'retry-after-ms': '5' }),
      () => {
        throw failure
      },
      () => textResponse('', 503),
      ok,
    ])

    const response = await send(fetch, {
      shouldRetry: (context) => {
        contexts.push(context)
        return context.response?.status === 400 ? true : undefined
      },
    })

    expect(response.status).toBe(200)
    expect(contexts).toMatchObject([
      { attempt: 0, response: { status: 400 }, retryAfterInMs: 5 },
      { attempt: 1, error: failure },
      { attempt: 2, response: { status: 503 } },
    ])
  })

  test('shouldRetry cannot exceed maxRetries', async () => {
    const { fetch } = statuses(400, 400, 400)

    await send(fetch, { maxRetries: 1, shouldRetry: () => true })

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('retryDelay sets the wait and falls back to the default for undefined', async () => {
    const { fetch, times } = statuses(503, 503, 200)

    await send(fetch, { retryDelay: ({ attempt }) => (attempt === 0 ? 50 : undefined) })

    expect(gaps(times)).toStrictEqual([50, 1600])
  })

  test('a request overrides the client options', async () => {
    const { fetch } = statuses(503, 503, 503)
    const client = new AzureClient({ credential, retryOptions: { maxRetries: 0 }, fetch })

    const response = client.fetch(url, { azure: { retryOptions: { maxRetries: 2 } } })
    await vi.runAllTimersAsync()
    await response

    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test('service clients accept retry options', async () => {
    const keyVault = statuses(503, 503)
    const secrets = new KeyVaultSecretClient('https://example.vault.azure.net', credential, {
      retryOptions: { maxRetries: 0 },
      fetch: keyVault.fetch,
    })
    const tables = statuses(503, 503)
    const table = new TableClient('https://example.table.core.windows.net/table', credential, {
      retryOptions: { maxRetries: 0 },
      fetch: tables.fetch,
    })

    await expect(secrets.getSecret('name')).rejects.toMatchObject({ status: 503 })
    await expect(table.getEntity('pk', 'rk')).rejects.toMatchObject({ status: 503 })
    expect(keyVault.fetch).toHaveBeenCalledTimes(1)
    expect(tables.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('cancellation and bodies', () => {
  test('aborting during a wait rejects with the reason and starts no further attempt', async () => {
    const { fetch } = statuses(503, 200)
    const controller = new AbortController()
    const reason = new Error('cancelled during the wait')

    const response = new AzureClient({ credential, fetch }).fetch(url, {
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort(reason)

    await expect(response).rejects.toBe(reason)
    await vi.runAllTimersAsync()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['string', () => 'payload', 'payload'],
    ['bytes', () => new TextEncoder().encode('payload'), 'payload'],
    ['blob', () => new Blob(['payload']), 'payload'],
    ['form', () => new URLSearchParams({ key: 'value' }), 'key=value'],
  ])('sends the same %s body on every attempt', async (_kind, body, expected) => {
    // Reading a blob body settles after pending timers have run, so this test waits for real.
    vi.useRealTimers()
    const bodies: string[] = []
    const record: FetchHandler = (_url, init) => {
      bodies.push(getBodyString(init.body))
      return textResponse('', bodies.length === 1 ? 503 : 200)
    }
    const client = new AzureClient({
      credential,
      retryOptions: { retryDelay: () => 0 },
      fetch: createFetchMock([record, record]),
    })

    await client.fetch(url, { method: 'POST', body: body() })

    expect(bodies).toStrictEqual([expected, expected])
  })

  test('does not retry a stream body', async () => {
    const { fetch } = statuses(503, 200)
    const body = new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('payload'))
        controller.close()
      },
    })

    // Node requires `duplex` for stream bodies; the DOM types don't declare it yet.
    const init: RequestInit & { duplex: 'half' } = { method: 'PUT', body, duplex: 'half' }

    const response = await send(fetch, undefined, init)

    expect(response.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('rejects at once when the caller aborts while a discarded body is released', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled while releasing the body')
    const abortsOnRelease = () =>
      new Response(
        new ReadableStream({
          cancel: () => {
            controller.abort(reason)
          },
        }),
        { status: 503 },
      )
    const fetch = createFetchMock([abortsOnRelease, ok])

    await expect(
      new AzureClient({ credential, fetch }).fetch(url, { signal: controller.signal }),
    ).rejects.toBe(reason)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('does not send or retry a token or storage request that fetch cannot build', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()

    await expect(
      getServicePrincipalToken({
        tenantId: 'tenant',
        clientId: 'client',
        clientSecret: 'secret',
        scope: 'https://resource/.default',
        authorityHost: 'https://user:password@login.example.com',
        fetch,
      }),
    ).rejects.toBeInstanceOf(TokenRequestError)
    await expect(
      new BlockBlobClient('https://user:password@account.blob.core.windows.net/c/b', credential, {
        fetch,
      }).upload('payload'),
    ).rejects.toBeInstanceOf(TypeError)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('token requests keep their error type when retries run out', async () => {
    const fetch = createFetchMock([
      tokenUnavailable,
      tokenUnavailable,
      tokenUnavailable,
      tokenUnavailable,
    ])

    const rejection = rejectionOf(
      new ClientSecretCredential('tenant', 'client', 'secret', { fetch }).getToken(
        'https://resource/.default',
      ),
    )
    await vi.runAllTimersAsync()

    await expect(rejection).resolves.toBeInstanceOf(TokenRequestError)
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})
