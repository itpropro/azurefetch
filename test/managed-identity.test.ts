import { beforeEach, describe, expect, test, vi } from 'vitest'

import { getManagedIdentityToken } from '../src/managed-identity'
import { TokenUnavailableError } from '../src/token-unavailable-error'
import { clearCredentialEnvironment, createFetchMock, getBodyString, jsonResponse } from './helpers'

const scope = 'https://vault.azure.net/.default'
const tokenResponse = () => jsonResponse({ access_token: 'mi-token', expires_in: 600 })

function useAppService(): void {
  vi.stubEnv('IDENTITY_ENDPOINT', 'https://appservice.azurewebsites.net/identity')
  vi.stubEnv('IDENTITY_HEADER', 'app-header-token')
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
        return new Response('missing metadata header', { status: 400 })
      },
      (url, init) => {
        const requestUrl = new URL(url)
        expect(requestUrl.searchParams.get('api-version')).toBe('2018-02-01')
        expect(requestUrl.searchParams.get('object_id')).toBe('object-1')
        expect(new Headers(init.headers).get('Metadata')).toBe('true')
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

  test.each([
    { status: 400, name: 'TokenRequestError' },
    { status: 503, name: 'TokenUnavailableError' },
  ])('maps a $status token response to $name', async ({ status, name }) => {
    vi.stubEnv('MSI_ENDPOINT', 'http://localhost:8080/msi/token')
    const fetchMock = createFetchMock([() => jsonResponse({ error: 'invalid_resource' }, status)])

    await expect(getManagedIdentityToken({ scope, fetch: fetchMock })).rejects.toMatchObject({
      name,
    })
  })
})
