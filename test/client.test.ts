import { beforeEach, describe, expect, test, vi } from 'vitest'

import { AzureClient } from '../src/client'
import { DefaultAzureCredential } from '../src/default-azure-credential'
import type { AccessToken } from '../src/types'
import { clearCredentialEnvironment, createFetchMock, getBodyString, jsonResponse } from './helpers'

function recordingFetch() {
  return vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
}

function sentRequest(fetcher: ReturnType<typeof recordingFetch>): Request {
  const [input, init] = fetcher.mock.calls[0] ?? []
  if (input === undefined) {
    throw new Error('Expected a request')
  }

  return new Request(input, init)
}

describe('AzureClient', () => {
  beforeEach(() => {
    clearCredentialEnvironment()
  })

  test('rejects HTTP authority hosts during construction', () => {
    expect(() => new AzureClient({ authorityHost: 'http://identity.test' })).toThrow(
      'authorityHost must use HTTPS',
    )
    expect(() => new DefaultAzureCredential({ authorityHost: 'http://identity.test' })).toThrow(
      'authorityHost must use HTTPS',
    )
  })

  test.each([
    { tokenType: undefined, expected: 'Bearer token-value' },
    { tokenType: 'pop' as const, expected: 'pop token-value' },
  ])('authorizes with token credentials of type $tokenType', async ({ tokenType, expected }) => {
    const fetcher = recordingFetch()
    const getToken = vi.fn<() => Promise<AccessToken>>(async () => ({
      token: 'token-value',
      tokenType,
      expiresOnTimestamp: Date.now() + 60_000,
    }))

    await new AzureClient({ credential: { getToken }, fetch: fetcher }).fetch(
      'https://example.com',
      { method: 'POST' },
    )

    const request = sentRequest(fetcher)
    expect(request.method).toBe('POST')
    expect(request.headers.get('Authorization')).toBe(expected)
    expect(getToken).toHaveBeenCalledWith(['https://storage.azure.com/.default'])
  })

  test('prefers getAuthorizationHeader over getToken on mixed credentials', async () => {
    const fetcher = recordingFetch()
    const getToken = vi.fn<() => Promise<AccessToken>>(async () => ({
      token: 'token-value',
      expiresOnTimestamp: 0,
    }))

    await new AzureClient({
      credential: { getAuthorizationHeader: async () => 'Bearer header-token', getToken },
      fetch: fetcher,
    }).fetch('https://example.com')

    expect(sentRequest(fetcher).headers.get('Authorization')).toBe('Bearer header-token')
    expect(getToken).not.toHaveBeenCalled()
  })

  test('supports per-request credential and scope overrides', async () => {
    const fetcher = recordingFetch()
    const defaultCredential = {
      getAuthorizationHeader: vi.fn<(scope?: string | string[]) => Promise<string>>(
        async () => 'Bearer default',
      ),
    }
    const overrideCredential = {
      getAuthorizationHeader: vi.fn<(scope?: string | string[]) => Promise<string>>(
        async () => 'Bearer override',
      ),
    }

    await new AzureClient({ credential: defaultCredential, fetch: fetcher }).fetch(
      'https://example.com',
      {
        azure: { credential: overrideCredential, scope: 'https://graph.microsoft.com/.default' },
      },
    )

    expect(defaultCredential.getAuthorizationHeader).not.toHaveBeenCalled()
    expect(overrideCredential.getAuthorizationHeader).toHaveBeenCalledWith(
      'https://graph.microsoft.com/.default',
    )
    expect(sentRequest(fetcher).headers.get('Authorization')).toBe('Bearer override')
  })

  test('falls back to the default credential chain with the per-request authority host', async () => {
    vi.stubEnv('AZURE_TENANT_ID', 'tenant')
    vi.stubEnv('AZURE_CLIENT_ID', 'client')
    vi.stubEnv('AZURE_CLIENT_SECRET', 'secret')
    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe('https://login.override.test/tenant/oauth2/v2.0/token')
        expect(new URLSearchParams(getBodyString(init.body)).get('scope')).toBe(
          'https://graph.microsoft.com/.default',
        )
        return jsonResponse({ access_token: 'chain-token', expires_in: 3600 })
      },
      (_url, init) => {
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer chain-token')
        return new Response(null, { status: 204 })
      },
    ])

    const response = await new AzureClient({
      authorityHost: 'https://login.default.test',
      fetch: fetcher,
    }).fetch('https://example.com', {
      azure: {
        scope: 'https://graph.microsoft.com/.default',
        authorityHost: 'https://login.override.test',
      },
    })

    expect(response.status).toBe(204)
  })
})
