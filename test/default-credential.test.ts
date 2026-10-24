import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { DefaultAzureCredential } from '../src/default-azure-credential'
import {
  getDefaultAzureCredentialToken,
  getDeveloperAzureCredentialToken,
} from '../src/default-credential'
import { TokenRequestError } from '../src/token-request-error'
import { TokenUnavailableError } from '../src/token-unavailable-error'
import { clearCredentialEnvironment, createFetchMock, getBodyString, jsonResponse } from './helpers'

const scope = 'scope/.default'
const printToken = (token: string) =>
  `printf '%s' '{"accessToken":"${token}","expires_on":1700000000}'`
const imdsUnavailable = () => {
  throw new TypeError('fetch failed')
}
const tokenForRequestedScope = (_url: string, init: RequestInit) =>
  jsonResponse({
    access_token: new URLSearchParams(getBodyString(init.body)).get('scope'),
    expires_in: 3600,
  })
const azureCliCall = /^az /u
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
    const calls = await installCommands({ az: 'echo not json', pwsh: printToken('ps-token') })

    await expect(getDeveloperAzureCredentialToken({ scope })).rejects.toBeInstanceOf(
      TokenRequestError,
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
