import { inspect } from 'node:util'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ClientSecretCredential } from '../src/client-secret-credential'
import { TokenRequestError } from '../src/token-request-error'
import { TokenUnavailableError } from '../src/token-unavailable-error'
import type { AbortSignalLike } from '../src/types'
import { clearCredentialEnvironment, createFetchMock, getBodyString, jsonResponse } from './helpers'

const scope = 'https://resource/.default'
const claims = '{"access_token":{"nbf":{"essential":true,"value":"1700000000"}}}'
const caeCapability = { xms_cc: { values: ['cp1'] } }

const tokenForRequestedScope = (_url: string, init: RequestInit) =>
  jsonResponse({
    access_token: new URLSearchParams(getBodyString(init.body)).get('scope'),
    expires_in: 3600,
  })

interface TokenRequest {
  url: string
  form: Record<string, string>
  signal?: AbortSignal | null
}

/** Answers token requests with `token-<n>` after `delayMs`, unless the request is aborted first. */
function tokenEndpoint(delayMs = 0) {
  const requests: TokenRequest[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const signal = init?.signal
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      form: Object.fromEntries(new URLSearchParams(getBodyString(init?.body))),
      signal,
    })
    const token = `token-${requests.length}`
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delayMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
    })
    signal?.throwIfAborted()
    return jsonResponse({ access_token: token, expires_in: 3600 })
  })

  return { fetch, requests }
}

/** A signal with only the members of the Azure SDK `AbortSignalLike` contract. */
function sdkSignal(): { signal: AbortSignalLike; abort: () => void } {
  const controller = new AbortController()
  return {
    signal: {
      get aborted() {
        return controller.signal.aborted
      },
      addEventListener: (type, listener) => {
        controller.signal.addEventListener(type, listener)
      },
      removeEventListener: (type, listener) => {
        controller.signal.removeEventListener(type, listener)
      },
    },
    abort: () => {
      controller.abort()
    },
  }
}

beforeEach(() => {
  clearCredentialEnvironment()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ClientSecretCredential', () => {
  test('caches service principal tokens separately per scope', async () => {
    const fetchMock = createFetchMock([tokenForRequestedScope, tokenForRequestedScope])
    const credential = new ClientSecretCredential('tenant', 'client', 'secret', {
      fetch: fetchMock,
    })

    await expect(credential.getToken('a/.default')).resolves.toMatchObject({ token: 'a/.default' })
    await expect(credential.getToken(['a/.default'])).resolves.toMatchObject({
      token: 'a/.default',
    })
    await expect(credential.getToken('b/.default')).resolves.toMatchObject({ token: 'b/.default' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('keeps the client secret out of logs and serialization', () => {
    const credential = new ClientSecretCredential('tenant', 'client', 'super-secret')

    expect(inspect(credential)).not.toContain('super-secret')
    expect(JSON.stringify(credential)).not.toContain('super-secret')
  })

  describe('getToken options', () => {
    test('requests allowed tenants and caches tokens per effective tenant', async () => {
      const { fetch, requests } = tokenEndpoint()
      const credential = new ClientSecretCredential('home', 'client', 'secret', {
        additionallyAllowedTenants: ['guest'],
        fetch,
      })

      await expect(credential.getToken(scope, { tenantId: 'guest' })).resolves.toMatchObject({
        token: 'token-1',
      })
      await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'token-2' })
      await expect(credential.getToken(scope, { tenantId: 'home' })).resolves.toMatchObject({
        token: 'token-2',
      })
      expect(requests.map(({ url }) => url)).toStrictEqual([
        'https://login.microsoftonline.com/guest/oauth2/v2.0/token',
        'https://login.microsoftonline.com/home/oauth2/v2.0/token',
      ])
    })

    test('rejects a tenant that is not allowed and accepts any tenant with *', async () => {
      const { fetch, requests } = tokenEndpoint()

      const refused = new ClientSecretCredential('home', 'client', 'secret', { fetch }).getToken(
        scope,
        { tenantId: 'guest' },
      )
      await expect(refused).rejects.toBeInstanceOf(TokenUnavailableError)
      await expect(refused).rejects.toThrow(
        'The credential is not configured to acquire tokens for tenant guest. Add it to additionallyAllowedTenants',
      )
      expect(requests).toHaveLength(0)

      const anyTenant = new ClientSecretCredential('home', 'client', 'secret', {
        additionallyAllowedTenants: ['*'],
        fetch,
      })
      await anyTenant.getToken(scope, { tenantId: 'guest' })
      expect(requests[0]?.url).toContain('/guest/')
    })

    test('ignores the per-call tenant for ADFS and when multi-tenant authentication is disabled', async () => {
      const { fetch, requests } = tokenEndpoint()

      await new ClientSecretCredential('adfs', 'client', 'secret', { fetch }).getToken(scope, {
        tenantId: 'guest',
      })
      vi.stubEnv('AZURE_IDENTITY_DISABLE_MULTITENANTAUTH', 'true')
      await new ClientSecretCredential('home', 'client', 'secret', { fetch }).getToken(scope, {
        tenantId: 'guest',
      })

      expect(requests.map(({ url }) => url)).toStrictEqual([
        'https://login.microsoftonline.com/adfs/oauth2/v2.0/token',
        'https://login.microsoftonline.com/home/oauth2/v2.0/token',
      ])
    })

    test('rejects a per-call tenant that the shell or PowerShell would interpret', async () => {
      const { fetch } = tokenEndpoint()
      const credential = new ClientSecretCredential('home', 'client', 'secret', {
        additionallyAllowedTenants: ['*'],
        fetch,
      })

      await expect(credential.getToken(scope, { tenantId: "guest'&calc" })).rejects.toBeInstanceOf(
        TypeError,
      )
      expect(fetch).not.toHaveBeenCalled()
    })

    test('requests the cp1 capability for CAE and caches CAE tokens separately', async () => {
      const { fetch, requests } = tokenEndpoint()
      const credential = new ClientSecretCredential('home', 'client', 'secret', { fetch })

      await credential.getToken(scope)
      await credential.getToken(scope, { enableCae: true })
      await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'token-1' })
      await expect(credential.getToken(scope, { enableCae: true })).resolves.toMatchObject({
        token: 'token-2',
      })

      expect(requests[0]?.form).not.toHaveProperty('claims')
      expect(JSON.parse(requests[1]?.form['claims'] ?? '')).toStrictEqual({
        access_token: caeCapability,
      })
    })

    test('sends a claims challenge, merges CAE into it and replaces the cached token', async () => {
      const { fetch, requests } = tokenEndpoint()
      const credential = new ClientSecretCredential('home', 'client', 'secret', { fetch })

      await credential.getToken(scope, { enableCae: true })
      await expect(credential.getToken(scope, { enableCae: true, claims })).resolves.toMatchObject({
        token: 'token-2',
      })
      await expect(credential.getToken(scope, { enableCae: true })).resolves.toMatchObject({
        token: 'token-2',
      })

      expect(requests).toHaveLength(2)
      expect(JSON.parse(requests[1]?.form['claims'] ?? '')).toStrictEqual({
        access_token: { nbf: { essential: true, value: '1700000000' }, ...caeCapability },
      })
    })

    test('treats blank claims as no challenge', async () => {
      const { fetch, requests } = tokenEndpoint()
      const credential = new ClientSecretCredential('home', 'client', 'secret', { fetch })

      await credential.getToken(scope)
      await credential.getToken(scope, { claims: ' ' })

      expect(requests).toHaveLength(1)
    })

    test('keeps a claims result over an ordinary refresh that started earlier', async () => {
      vi.useFakeTimers()
      const { fetch, requests } = tokenEndpoint(1000)
      const credential = new ClientSecretCredential('home', 'client', 'secret', { fetch })

      const ordinary = credential.getToken(scope)
      await vi.advanceTimersByTimeAsync(500)
      const challenged = credential.getToken(scope, { claims })
      await vi.advanceTimersByTimeAsync(1000)

      await expect(ordinary).resolves.toMatchObject({ token: 'token-1' })
      await expect(challenged).resolves.toMatchObject({ token: 'token-2' })
      expect(requests[1]?.form['claims']).toBe(claims)
      await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'token-2' })
      expect(requests).toHaveLength(2)
    })

    test('bypasses the failed-refresh wait for claims and never falls back for them', async () => {
      vi.useFakeTimers({ now: 0 })
      const fetch = createFetchMock([
        () => jsonResponse({ access_token: 'cached', expires_in: 3600 }),
        () => jsonResponse({ error: 'temporarily_unavailable' }, 503, 'Service Unavailable'),
        () => jsonResponse({ error: 'invalid_grant' }, 400, 'Bad Request'),
        () => jsonResponse({ access_token: 'challenged', expires_in: 3600 }),
      ])
      const credential = new ClientSecretCredential('home', 'client', 'secret', {
        retryOptions: { maxRetries: 0 },
        fetch,
      })
      await credential.getToken(scope)

      vi.setSystemTime(3_300_000)
      await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'cached' })
      await expect(credential.getToken(scope, { claims })).rejects.toBeInstanceOf(TokenRequestError)
      await expect(credential.getToken(scope, { claims })).resolves.toMatchObject({
        token: 'challenged',
      })
      await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'challenged' })
    })
  })

  describe('cancellation', () => {
    test('rejects an already-aborted call without a request, even with a cached token', async () => {
      const { fetch } = tokenEndpoint()
      const credential = new ClientSecretCredential('home', 'client', 'secret', { fetch })
      await credential.getToken(scope)
      const reason = new Error('cancelled')

      await expect(
        credential.getToken(scope, { abortSignal: AbortSignal.abort(reason) }),
      ).rejects.toBe(reason)
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    test('rejects only the caller that aborts a shared request', async () => {
      vi.useFakeTimers()
      const { fetch, requests } = tokenEndpoint(1000)
      const credential = new ClientSecretCredential('home', 'client', 'secret', { fetch })
      const controller = new AbortController()
      const reason = new Error('caller cancelled')

      const aborting = credential.getToken(scope, { abortSignal: controller.signal })
      const waiting = credential.getToken(scope)
      controller.abort(reason)

      await expect(aborting).rejects.toBe(reason)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(waiting).resolves.toMatchObject({ token: 'token-1' })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.signal?.aborted).toBe(false)
    })

    test('cancels the shared request once every caller aborts, then starts a fresh one', async () => {
      vi.useFakeTimers()
      const { fetch, requests } = tokenEndpoint(1000)
      const credential = new ClientSecretCredential('home', 'client', 'secret', { fetch })
      const first = sdkSignal()
      const second = sdkSignal()

      const callers = Promise.allSettled([
        credential.getToken(scope, { abortSignal: first.signal }),
        credential.getToken(scope, { abortSignal: second.signal }),
      ])
      await vi.advanceTimersByTimeAsync(0)
      first.abort()
      expect(requests[0]?.signal?.aborted).toBe(false)
      second.abort()

      const results = await callers
      expect(results.map((result) => result.status)).toStrictEqual(['rejected', 'rejected'])
      expect(results[0]).toMatchObject({ reason: { name: 'AbortError' } })
      expect(requests[0]?.signal?.aborted).toBe(true)

      const fresh = credential.getToken(scope)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(fresh).resolves.toMatchObject({ token: 'token-2' })
    })

    test('starts a fresh refresh after an aborted one instead of waiting', async () => {
      vi.useFakeTimers({ now: 0 })
      const { fetch } = tokenEndpoint(1000)
      const credential = new ClientSecretCredential('home', 'client', 'secret', { fetch })
      const initial = credential.getToken(scope)
      await vi.advanceTimersByTimeAsync(1000)
      await initial
      const reason = new Error('cancelled refresh')
      const controller = new AbortController()

      vi.setSystemTime(3_400_000)
      const refresh = credential.getToken(scope, { abortSignal: controller.signal })
      controller.abort(reason)

      await expect(refresh).rejects.toBe(reason)
      const next = credential.getToken(scope)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(next).resolves.toMatchObject({ token: 'token-3' })
    })
  })
})
