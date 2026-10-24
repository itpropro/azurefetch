import { X509Certificate, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { DefaultAzureCredential } from '../src/default-azure-credential'
import {
  getDefaultAzureCredentialToken,
  getDeveloperAzureCredentialToken,
} from '../src/default-credential'
import { jsonProperty } from '../src/internal/json'
import { getManagedIdentityToken } from '../src/managed-identity'
import { TokenRequestError } from '../src/token-request-error'
import { TokenUnavailableError } from '../src/token-unavailable-error'
import { clearCredentialEnvironment, createFetchMock, getBodyString, jsonResponse } from './helpers'

// The fake executables are POSIX shell scripts; Windows behavior is not covered by this suite.
const scope = 'scope/.default'
const printToken = (token: string) =>
  `printf '%s' '{"accessToken":"${token}","expires_on":1700000000}'`
const imdsTokenUnavailable = () => jsonResponse({ error: 'unavailable' }, 503)
const imdsUnavailable = () => {
  throw new TypeError('fetch failed')
}
const tokenForRequestedScope = (_url: string, init: RequestInit) =>
  jsonResponse({
    access_token: new URLSearchParams(getBodyString(init.body)).get('scope'),
    expires_in: 3600,
  })
const azureCliCall = /^az /u
const appServiceIdentityUrl = /^https:\/\/appservice\.azurewebsites\.net\/identity\?/u
const credentialFields = new Set(['client_secret', 'client_assertion', 'password'])
/** Length of an array property of decoded JSON, or `undefined` when it is absent. */
const jsonLength = (value: unknown, key: string): number | undefined => {
  const property = jsonProperty(value, key)
  return Array.isArray(property) ? property.length : undefined
}
const tokenRequest = (url: string, init: RequestInit) => ({
  url,
  form: Object.fromEntries(new URLSearchParams(getBodyString(init.body))),
})
const commandDirectories: string[] = []

/** Replaces PATH with fake executables that log their arguments and run the given shell body. */
async function installCommands(
  commands: Partial<Record<'az' | 'pwsh' | 'powershell', string>>,
): Promise<() => Promise<string[]>> {
  const directory = await mkdtemp(join(tmpdir(), 'azurefetch-commands-'))
  commandDirectories.push(directory)
  const log = join(directory, 'calls.log')
  await Promise.all(
    Object.entries(commands).map(async ([name, body]) => {
      const script = `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\n`
      await writeFile(join(directory, name), script, { mode: 0o755 })
    }),
  )

  vi.stubEnv('PATH', directory)
  return async () => {
    try {
      return (await readFile(log, 'utf8')).trimEnd().split('\n')
    } catch {
      return []
    }
  }
}

function useServicePrincipalEnvironment(): void {
  vi.stubEnv('AZURE_TENANT_ID', 'tenant')
  vi.stubEnv('AZURE_CLIENT_ID', 'client')
  vi.stubEnv('AZURE_CLIENT_SECRET', 'secret')
}

function useAppServiceEnvironment(): void {
  vi.stubEnv('IDENTITY_ENDPOINT', 'https://appservice.azurewebsites.net/identity')
  vi.stubEnv('IDENTITY_HEADER', 'identity-header')
}

/** Mirrors what the AKS workload identity webhook injects, next to a managed identity endpoint. */
async function useWorkloadIdentityEnvironment(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'azurefetch-workload-'))
  commandDirectories.push(directory)
  const tokenFile = join(directory, 'azure-identity-token')
  await writeFile(tokenFile, 'federated-assertion\n')

  vi.stubEnv('AZURE_TENANT_ID', 'pod-tenant')
  vi.stubEnv('AZURE_CLIENT_ID', 'workload-client')
  vi.stubEnv('AZURE_FEDERATED_TOKEN_FILE', tokenFile)
  useAppServiceEnvironment()
  return tokenFile
}

const certificatePath = (name: string) =>
  fileURLToPath(new URL(`fixtures/certificates/${name}`, import.meta.url))
const tokenUrl = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token'

function useEnvironment(variables: Record<string, string>): void {
  for (const [name, value] of Object.entries({
    AZURE_TENANT_ID: 'tenant',
    AZURE_CLIENT_ID: 'client',
    ...variables,
  })) {
    vi.stubEnv(name, value)
  }
}

/** Records each token request's URL and form fields and answers with a token. */
function environmentTokenEndpoint() {
  const requests: ReturnType<typeof tokenRequest>[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    requests.push(tokenRequest(input instanceof Request ? input.url : input.toString(), init))
    return jsonResponse({ access_token: `token-${requests.length}`, expires_in: 3600 })
  })
  return { fetch, requests }
}

function decodeJwt(token: string | undefined): { header: unknown; claims: unknown } {
  const [header = '', claims = ''] = (token ?? '').split('.')
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()),
  }
}

beforeEach(() => {
  clearCredentialEnvironment()
})

afterEach(async () => {
  await Promise.all(
    commandDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
    }),
  )
})

describe('getDefaultAzureCredentialToken', () => {
  test('uses the environment service principal first', async () => {
    useServicePrincipalEnvironment()
    useAppServiceEnvironment()
    const calls = await installCommands({ az: printToken('cli-token') })
    const fetchMock = createFetchMock([
      (url) => {
        expect(url).toBe('https://identity.test/tenant/oauth2/v2.0/token')
        return jsonResponse({ access_token: 'sp-token', expires_in: 3600 })
      },
    ])

    const token = await getDefaultAzureCredentialToken({
      scope,
      authorityHost: 'https://identity.test',
      fetch: fetchMock,
    })

    expect(token.token).toBe('sp-token')
    await expect(calls()).resolves.toStrictEqual([])
  })

  test('does not continue when the service principal request fails', async () => {
    useServicePrincipalEnvironment()
    const calls = await installCommands({ az: printToken('cli-token') })
    const fetchMock = createFetchMock([
      () => jsonResponse({ error: 'invalid_client' }, 401, 'Unauthorized'),
    ])

    await expect(
      getDefaultAzureCredentialToken({ scope, fetch: fetchMock }),
    ).rejects.toBeInstanceOf(TokenRequestError)
    await expect(calls()).resolves.toStrictEqual([])
  })

  test('falls back to managed identity without a service principal', async () => {
    useAppServiceEnvironment()
    const fetchMock = createFetchMock([
      () => jsonResponse({ access_token: 'mi-token', expires_in: 3600 }),
    ])

    const token = await getDefaultAzureCredentialToken({ scope, fetch: fetchMock })

    expect(token.token).toBe('mi-token')
  })

  test('exchanges the workload identity token before trying managed identity', async () => {
    await useWorkloadIdentityEnvironment()
    const fetchMock = createFetchMock([
      (url, init) => {
        expect(url).toBe('https://login.microsoftonline.com/override-tenant/oauth2/v2.0/token')
        expect(Object.fromEntries(new URLSearchParams(getBodyString(init.body)))).toStrictEqual({
          client_id: 'workload-client',
          client_assertion: 'federated-assertion',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          grant_type: 'client_credentials',
          scope,
        })
        return jsonResponse({ access_token: 'workload-token', expires_in: 3600 })
      },
    ])

    const token = await getDefaultAzureCredentialToken({
      scope,
      tenantId: 'override-tenant',
      fetch: fetchMock,
    })

    expect(token.token).toBe('workload-token')
  })

  test('does not fall back to managed identity when the workload token file is missing', async () => {
    await rm(await useWorkloadIdentityEnvironment())
    const fetchMock = vi.fn<typeof fetch>()

    await expect(getDefaultAzureCredentialToken({ scope, fetch: fetchMock })).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('rejects a tenant ID that the shell or PowerShell would interpret', async () => {
    const calls = await installCommands({ az: printToken('cli-token') })

    await expect(
      getDefaultAzureCredentialToken({
        scope,
        tenantId: "tenant'&calc",
        fetch: vi.fn<typeof fetch>(),
      }),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(calls()).resolves.toStrictEqual([])
  })

  test('moves on to Azure CLI after IMDS keeps answering 5xx through its retries', async () => {
    const calls = await installCommands({ az: printToken('cli-token') })
    const fetchMock = createFetchMock([
      () => jsonResponse({ error: 'invalid_request' }, 400),
      ...Array.from({ length: 6 }, () => imdsTokenUnavailable),
    ])

    const token = await getDefaultAzureCredentialToken({
      scope,
      retryOptions: { retryDelay: () => 0 },
      fetch: fetchMock,
    })

    expect(token.token).toBe('cli-token')
    expect(fetchMock).toHaveBeenCalledTimes(7)
    await expect(calls()).resolves.toHaveLength(1)
  })

  test('falls back to Azure CLI when managed identity is unavailable', async () => {
    const calls = await installCommands({ az: printToken('cli-token') })

    const token = await getDefaultAzureCredentialToken({
      scope,
      fetch: createFetchMock([imdsUnavailable]),
    })

    expect(token).toStrictEqual({
      token: 'cli-token',
      tokenType: 'Bearer',
      expiresOnTimestamp: 1_700_000_000_000,
    })
    await expect(calls()).resolves.toStrictEqual([
      'az account get-access-token --output json --scope scope/.default',
    ])
  })
})

describe('DefaultAzureCredential', () => {
  test('forwards the managed identity client ID', async () => {
    useAppServiceEnvironment()
    const fetchMock = createFetchMock([
      (url) => {
        expect(new URL(url).searchParams.get('client_id')).toBe('user-assigned-client')
        return jsonResponse({ access_token: 'mi-token', expires_in: 3600 })
      },
    ])

    const credential = new DefaultAzureCredential({
      managedIdentityClientId: 'user-assigned-client',
      fetch: fetchMock,
    })

    await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'mi-token' })
  })

  test('scopes Azure CLI and Azure PowerShell to the requested tenant', async () => {
    const calls = await installCommands({ az: 'exit 1', pwsh: printToken('ps-token') })
    const credential = new DefaultAzureCredential({
      tenantId: 'contoso.onmicrosoft.com',
      fetch: createFetchMock([imdsUnavailable]),
    })

    await expect(credential.getToken('https://resource/.default')).resolves.toMatchObject({
      token: 'ps-token',
    })
    const [cliCall, powerShellCall] = await calls()
    expect(cliCall).toBe(
      'az account get-access-token --output json --scope https://resource/.default --tenant contoso.onmicrosoft.com',
    )
    expect(powerShellCall).toContain(
      "Get-AzAccessToken -ResourceUrl 'https://resource' -TenantId 'contoso.onmicrosoft.com'",
    )
  })

  test('caches tokens separately per scope', async () => {
    useServicePrincipalEnvironment()
    const fetchMock = createFetchMock([tokenForRequestedScope, tokenForRequestedScope])
    const credential = new DefaultAzureCredential({ fetch: fetchMock })

    await expect(credential.getAuthorizationHeader('a/.default')).resolves.toBe('Bearer a/.default')
    await expect(credential.getAuthorizationHeader('a/.default')).resolves.toBe('Bearer a/.default')
    await expect(credential.getAuthorizationHeader('b/.default')).resolves.toBe('Bearer b/.default')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('DefaultAzureCredential getToken options', () => {
  const claims = '{"access_token":{"nbf":{"essential":true,"value":"1700000000"}}}'
  const encodedClaims = Buffer.from(claims).toString('base64')

  test('allows the tenants in AZURE_ADDITIONALLY_ALLOWED_TENANTS for the environment service principal', async () => {
    useServicePrincipalEnvironment()
    vi.stubEnv('AZURE_ADDITIONALLY_ALLOWED_TENANTS', 'guest;other')
    const fetchMock = createFetchMock([
      (url) => {
        expect(url).toBe('https://login.microsoftonline.com/other/oauth2/v2.0/token')
        return jsonResponse({ access_token: 'other-token', expires_in: 3600 })
      },
    ])

    await expect(
      new DefaultAzureCredential({ fetch: fetchMock }).getToken(scope, { tenantId: 'other' }),
    ).resolves.toMatchObject({ token: 'other-token' })
  })

  test('prefers an empty additionallyAllowedTenants and stops the chain when the environment refuses the tenant', async () => {
    useServicePrincipalEnvironment()
    useAppServiceEnvironment()
    vi.stubEnv('AZURE_ADDITIONALLY_ALLOWED_TENANTS', 'guest')
    const calls = await installCommands({ az: printToken('cli-token') })
    const fetchMock = vi.fn<typeof fetch>()
    const credential = new DefaultAzureCredential({
      additionallyAllowedTenants: [],
      fetch: fetchMock,
    })

    await expect(credential.getToken(scope, { tenantId: 'guest' })).rejects.toBeInstanceOf(
      TokenUnavailableError,
    )
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(calls()).resolves.toStrictEqual([])
  })

  test('sends the allowed tenant, claims and CAE capability with workload identity', async () => {
    await useWorkloadIdentityEnvironment()
    const requests: ReturnType<typeof tokenRequest>[] = []
    const credential = new DefaultAzureCredential({
      additionallyAllowedTenants: ['guest'],
      fetch: createFetchMock([
        (url, init) => {
          requests.push(tokenRequest(url, init))
          return jsonResponse({ access_token: 'workload-token', expires_in: 3600 })
        },
      ]),
    })

    await expect(
      credential.getToken(scope, { tenantId: 'guest', claims, enableCae: true }),
    ).resolves.toMatchObject({ token: 'workload-token' })
    expect(requests[0]?.url).toBe('https://login.microsoftonline.com/guest/oauth2/v2.0/token')
    expect(JSON.parse(requests[0]?.form['claims'] ?? '')).toStrictEqual({
      access_token: {
        nbf: { essential: true, value: '1700000000' },
        xms_cc: { values: ['cp1'] },
      },
    })
  })

  test('moves on to managed identity, which ignores the per-call options, when workload identity refuses the tenant', async () => {
    await useWorkloadIdentityEnvironment()
    const fetchMock = createFetchMock([
      (url) => {
        expect(url).toMatch(appServiceIdentityUrl)
        expect([...new URL(url).searchParams.keys()]).toStrictEqual([
          'api-version',
          'resource',
          'client_id',
        ])
        return jsonResponse({ access_token: 'mi-token', expires_in: 3600 })
      },
    ])

    await expect(
      new DefaultAzureCredential({ fetch: fetchMock }).getToken(scope, {
        tenantId: 'guest',
        claims,
        enableCae: true,
      }),
    ).resolves.toMatchObject({ token: 'mi-token' })
  })

  test('answers claims with re-login commands for Azure CLI and Azure PowerShell, even with a cached token', async () => {
    const calls = await installCommands({ az: printToken('cli-token'), pwsh: printToken('ps') })
    const credential = new DefaultAzureCredential({
      fetch: createFetchMock([imdsUnavailable, imdsUnavailable, imdsUnavailable]),
    })
    await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'cli-token' })

    const withoutTenant = credential.getToken(scope, { claims })
    await expect(withoutTenant).rejects.toBeInstanceOf(TokenUnavailableError)
    await expect(withoutTenant).rejects.toThrow(
      `az login --claims-challenge ${encodedClaims} --scope ${scope} or Connect-AzAccount -ClaimsChallenge ${encodedClaims}`,
    )
    await expect(credential.getToken(scope, { claims, tenantId: 'contoso' })).rejects.toThrow(
      `az login --claims-challenge ${encodedClaims} --scope ${scope} --tenant contoso or Connect-AzAccount -ClaimsChallenge ${encodedClaims} -Tenant contoso`,
    )
    await expect(calls()).resolves.toHaveLength(1)
  })

  test('requests an allowed per-call tenant from Azure CLI', async () => {
    const calls = await installCommands({ az: printToken('cli-token') })
    const credential = new DefaultAzureCredential({
      tenantId: 'home',
      additionallyAllowedTenants: ['guest'],
      fetch: createFetchMock([imdsUnavailable]),
    })

    await credential.getToken(scope, { tenantId: 'guest' })

    await expect(calls()).resolves.toStrictEqual([
      'az account get-access-token --output json --scope scope/.default --tenant guest',
    ])
  })

  test('cancels the IMDS probe without trying developer credentials', async () => {
    const calls = await installCommands({ az: printToken('cli-token') })
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal
      await new Promise((resolve) => {
        signal?.addEventListener('abort', resolve)
      })
      signal?.throwIfAborted()
      return jsonResponse({})
    })
    const controller = new AbortController()
    const reason = new Error('cancelled default credential')

    const token = new DefaultAzureCredential({ fetch: fetchMock }).getToken(scope, {
      abortSignal: controller.signal,
    })
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    controller.abort(reason)

    await expect(token).rejects.toBe(reason)
    await expect(vi.waitFor(() => fetchMock.mock.calls[0]?.[1]?.signal?.aborted)).resolves.toBe(
      true,
    )
    await expect(calls()).resolves.toStrictEqual([])
  })
})

describe('environment credential sources', () => {
  test('signs a client assertion with the certificate in AZURE_CLIENT_CERTIFICATE_PATH', async () => {
    useEnvironment({ AZURE_CLIENT_CERTIFICATE_PATH: certificatePath('pkcs1.pem') })
    const { fetch, requests } = environmentTokenEndpoint()
    const certificate = new X509Certificate(await readFile(certificatePath('pkcs1.pem')))

    await expect(getDefaultAzureCredentialToken({ scope, fetch })).resolves.toMatchObject({
      token: 'token-1',
    })
    const [request] = requests
    expect(request?.url).toBe(tokenUrl)
    expect(request?.form).toMatchObject({
      client_id: 'client',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      grant_type: 'client_credentials',
      scope,
    })
    const { header, claims } = decodeJwt(request?.form['client_assertion'])
    expect(header).toStrictEqual({
      alg: 'PS256',
      typ: 'JWT',
      'x5t#S256': createHash('sha256').update(certificate.raw).digest('base64url'),
    })
    expect(claims).toMatchObject({ aud: tokenUrl, iss: 'client', sub: 'client' })
  })

  test.each([
    ['TRUE', 2],
    ['1', 2],
    ['yes', undefined],
  ])(
    'sends the chain as x5c when AZURE_CLIENT_SEND_CERTIFICATE_CHAIN is %s',
    async (flag, length) => {
      useEnvironment({
        AZURE_CLIENT_CERTIFICATE_PATH: certificatePath('chain.pem'),
        AZURE_CLIENT_SEND_CERTIFICATE_CHAIN: flag,
      })
      const { fetch, requests } = environmentTokenEndpoint()

      await getDefaultAzureCredentialToken({ scope, fetch })

      const { header } = decodeJwt(requests[0]?.form['client_assertion'])
      expect(jsonLength(header, 'x5c')).toBe(length)
    },
  )

  test('decrypts the certificate key with AZURE_CLIENT_CERTIFICATE_PASSWORD, keeping its whitespace', async () => {
    useEnvironment({
      AZURE_CLIENT_CERTIFICATE_PATH: certificatePath('encrypted-pkcs8.pem'),
      AZURE_CLIENT_CERTIFICATE_PASSWORD: ' fixture password ',
    })
    const { fetch } = environmentTokenEndpoint()

    await expect(getDefaultAzureCredentialToken({ scope, fetch })).resolves.toMatchObject({
      token: 'token-1',
    })
  })

  test('rejects a PFX certificate and stops the chain', async () => {
    useEnvironment({ AZURE_CLIENT_CERTIFICATE_PATH: certificatePath('client.pfx') })
    useAppServiceEnvironment()
    const calls = await installCommands({ az: printToken('cli-token') })
    const { fetch } = environmentTokenEndpoint()

    await expect(getDefaultAzureCredentialToken({ scope, fetch })).rejects.toThrow(
      'does not contain a PEM-encoded certificate',
    )
    expect(fetch).not.toHaveBeenCalled()
    await expect(calls()).resolves.toStrictEqual([])
  })

  test('requests a token with the username and password, keeping the password whitespace', async () => {
    useEnvironment({ AZURE_USERNAME: 'user@contoso.com', AZURE_PASSWORD: ' p@ss word ' })
    const { fetch, requests } = environmentTokenEndpoint()

    await getDefaultAzureCredentialToken({ scope, fetch })

    expect(requests[0]?.url).toBe(tokenUrl)
    expect(requests[0]?.form).toStrictEqual({
      client_id: 'client',
      grant_type: 'password',
      username: 'user@contoso.com',
      password: ' p@ss word ',
      scope,
    })
  })

  test('passes an Entra MFA error through unchanged and stops the chain', async () => {
    useEnvironment({ AZURE_USERNAME: 'user@contoso.com', AZURE_PASSWORD: 'password' })
    const calls = await installCommands({ az: printToken('cli-token') })
    const description = 'AADSTS50076: you must use multi-factor authentication'
    const fetchMock = createFetchMock([
      () => jsonResponse({ error: 'invalid_grant', error_description: description }, 400),
    ])

    await expect(getDefaultAzureCredentialToken({ scope, fetch: fetchMock })).rejects.toMatchObject(
      {
        name: 'TokenRequestError',
        status: 400,
        errorCode: 'invalid_grant',
        message: `400 OK: ${description}`,
      },
    )
    await expect(calls()).resolves.toStrictEqual([])
  })

  test('prefers a client secret, then a certificate, then a username and password', async () => {
    const { fetch, requests } = environmentTokenEndpoint()
    useEnvironment({
      AZURE_CLIENT_SECRET: 'secret',
      AZURE_CLIENT_CERTIFICATE_PATH: certificatePath('pkcs8.pem'),
      AZURE_USERNAME: 'user@contoso.com',
      AZURE_PASSWORD: 'password',
    })
    await getDefaultAzureCredentialToken({ scope, fetch })
    vi.stubEnv('AZURE_CLIENT_SECRET', undefined)
    await getDefaultAzureCredentialToken({ scope, fetch })
    vi.stubEnv('AZURE_CLIENT_CERTIFICATE_PATH', undefined)
    await getDefaultAzureCredentialToken({ scope, fetch })

    expect(
      requests.map(({ form }) => Object.keys(form).find((key) => credentialFields.has(key))),
    ).toStrictEqual(['client_secret', 'client_assertion', 'password'])
  })

  test('moves on when the environment is incomplete', async () => {
    useEnvironment({ AZURE_USERNAME: 'user@contoso.com' })
    useAppServiceEnvironment()
    const fetchMock = createFetchMock([
      () => jsonResponse({ access_token: 'mi-token', expires_in: 3600 }),
    ])

    await expect(
      getDefaultAzureCredentialToken({ scope, fetch: fetchMock }),
    ).resolves.toMatchObject({ token: 'mi-token' })
  })

  test('uses AZURE_CLIENT_ID for managed identity in the chain unless managedIdentityClientId is set', async () => {
    vi.stubEnv('AZURE_CLIENT_ID', 'environment-client')
    useAppServiceEnvironment()
    const clientIds: (string | null)[] = []
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input) => {
      clientIds.push(
        new URL(input instanceof Request ? input.url : input.toString()).searchParams.get(
          'client_id',
        ),
      )
      return jsonResponse({ access_token: 'mi-token', expires_in: 3600 })
    })

    await getDefaultAzureCredentialToken({ scope, fetch: fetchMock })
    await getDefaultAzureCredentialToken({
      scope,
      managedIdentityClientId: 'explicit-client',
      fetch: fetchMock,
    })
    await getManagedIdentityToken({ scope, fetch: fetchMock })

    expect(clientIds).toStrictEqual(['environment-client', 'explicit-client', null])
  })

  test.each([
    ['certificate', { AZURE_CLIENT_CERTIFICATE_PATH: certificatePath('pkcs8.pem') }],
    ['username and password', { AZURE_USERNAME: 'user@contoso.com', AZURE_PASSWORD: 'password' }],
  ])('honors the per-call tenant, claims and CAE for the %s source', async (_source, variables) => {
    useEnvironment({ ...variables, AZURE_ADDITIONALLY_ALLOWED_TENANTS: 'guest' })
    const { fetch, requests } = environmentTokenEndpoint()
    const credential = new DefaultAzureCredential({ fetch })
    const claims = '{"access_token":{"nbf":{"essential":true,"value":"1700000000"}}}'

    await credential.getToken(scope, { tenantId: 'guest', enableCae: true })
    await credential.getToken(scope, { tenantId: 'guest', enableCae: true, claims })
    await credential.getToken(scope)
    await credential.getToken(scope, { tenantId: 'guest', enableCae: true })

    expect(requests.map(({ url }) => url)).toStrictEqual([
      'https://login.microsoftonline.com/guest/oauth2/v2.0/token',
      'https://login.microsoftonline.com/guest/oauth2/v2.0/token',
      tokenUrl,
    ])
    expect(JSON.parse(requests[0]?.form['claims'] ?? '')).toStrictEqual({
      access_token: { xms_cc: { values: ['cp1'] } },
    })
    expect(JSON.parse(requests[1]?.form['claims'] ?? '')).toStrictEqual({
      access_token: { nbf: { essential: true, value: '1700000000' }, xms_cc: { values: ['cp1'] } },
    })
    await expect(credential.getToken(scope, { tenantId: 'other' })).rejects.toBeInstanceOf(
      TokenUnavailableError,
    )
  })

  test.each([
    ['certificate', { AZURE_CLIENT_CERTIFICATE_PATH: certificatePath('pkcs8.pem') }],
    ['username and password', { AZURE_USERNAME: 'user@contoso.com', AZURE_PASSWORD: 'password' }],
  ])('retries the %s token request and stops it on cancellation', async (_source, variables) => {
    useEnvironment(variables)
    const urls: string[] = []
    const retried = createFetchMock([
      (url) => {
        urls.push(url)
        return jsonResponse({ error: 'temporarily_unavailable' }, 503)
      },
      (url) => {
        urls.push(url)
        return jsonResponse({ access_token: 'retried', expires_in: 3600 })
      },
    ])
    await expect(
      getDefaultAzureCredentialToken({
        scope,
        retryOptions: { retryDelay: () => 0 },
        fetch: retried,
      }),
    ).resolves.toMatchObject({ token: 'retried' })

    const reason = new Error('cancelled environment credential')
    const controller = new AbortController()
    const hanging = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const signal = init?.signal
      await new Promise((resolve) => {
        signal?.addEventListener('abort', resolve)
      })
      signal?.throwIfAborted()
      return jsonResponse({})
    })
    const token = new DefaultAzureCredential({ fetch: hanging }).getToken(scope, {
      abortSignal: controller.signal,
    })
    await vi.waitFor(() => {
      expect(hanging).toHaveBeenCalledTimes(1)
    })
    controller.abort(reason)

    await expect(token).rejects.toBe(reason)
    expect(urls).toStrictEqual([tokenUrl, tokenUrl])
    expect(hanging.mock.calls[0]?.[0]).toBe(tokenUrl)
  })
})

describe('getDeveloperAzureCredentialToken', () => {
  test('uses Azure CLI without service principal or managed identity requests', async () => {
    useServicePrincipalEnvironment()
    useAppServiceEnvironment()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const calls = await installCommands({ az: printToken('cli-token') })

    const token = await getDeveloperAzureCredentialToken({ scope })

    expect(token.token).toBe('cli-token')
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(calls()).resolves.toHaveLength(1)
  })

  test('falls back to PowerShell after Azure CLI fails and pwsh is missing', async () => {
    const calls = await installCommands({ az: 'exit 1', powershell: printToken('ps-token') })

    const token = await getDeveloperAzureCredentialToken({ scope: 'https://resource/.default' })

    expect(token.token).toBe('ps-token')
    const [cliCall, powerShellCall] = await calls()
    expect(cliCall).toMatch(azureCliCall)
    expect(powerShellCall).toContain("Get-AzAccessToken -ResourceUrl 'https://resource'")
  })

  test('does not try Azure PowerShell after malformed Azure CLI output', async () => {
    const calls = await installCommands({
      az: 'echo leaked-token',
      pwsh: printToken('ps-token'),
    })

    await expect(getDeveloperAzureCredentialToken({ scope })).rejects.toSatisfy(
      (error) => error instanceof TokenRequestError && !inspect(error).includes('leaked-token'),
    )
    await expect(calls()).resolves.toHaveLength(1)
  })

  test('reports unavailable credentials when no command exists', async () => {
    await installCommands({})

    await expect(getDeveloperAzureCredentialToken({ scope })).rejects.toBeInstanceOf(
      TokenUnavailableError,
    )
  })

  test('starts no command for an already-aborted signal', async () => {
    const calls = await installCommands({ az: printToken('cli-token') })
    const reason = new Error('cancelled before developer authentication')

    await expect(
      getDeveloperAzureCredentialToken({ scope, abortSignal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason)
    await expect(calls()).resolves.toStrictEqual([])
  })

  test('stops a running Azure CLI on cancellation without trying PowerShell', async () => {
    const calls = await installCommands({
      az: 'while :; do :; done',
      pwsh: printToken('ps-token'),
    })
    const controller = new AbortController()
    const reason = new Error('cancelled developer authentication')

    const token = getDeveloperAzureCredentialToken({ scope, abortSignal: controller.signal })
    await vi.waitFor(async () => {
      await expect(calls()).resolves.toHaveLength(1)
    })
    controller.abort(reason)

    await expect(token).rejects.toBe(reason)
    await expect(calls()).resolves.toHaveLength(1)
  })

  test('rejects scopes that the Windows shell would interpret', async () => {
    const calls = await installCommands({ az: printToken('cli-token') })

    await expect(
      getDeveloperAzureCredentialToken({ scope: 'https://resource/.default&calc' }),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(calls()).resolves.toStrictEqual([])
  })
})
