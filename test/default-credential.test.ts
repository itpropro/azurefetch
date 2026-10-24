import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { DefaultAzureCredential } from '../src/default-azure-credential'
import {
  getDefaultAzureCredentialToken,
  getDeveloperAzureCredentialToken,
} from '../src/default-credential'
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
        expect([...new URL(url).searchParams.keys()]).toStrictEqual(['api-version', 'resource'])
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
