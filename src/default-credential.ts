import { normalizeCommandToken } from './internal/oauth'
import { resolveRequiredScopes } from './internal/request-core'
import {
  executeCommand,
  getEnv,
  hasCommandExecution,
  isCommandUnavailable,
  isWindows,
} from './internal/runtime'
import { getManagedIdentityToken } from './managed-identity'
import { getServicePrincipalToken } from './service-principal'
import { TokenUnavailableError } from './token-unavailable-error'
import type { AccessToken } from './types'

export interface DefaultAzureCredentialOptions {
  authorityHost?: string
  managedIdentityClientId?: string
  fetch?: typeof globalThis.fetch
}

export interface DefaultAzureCredentialTokenOptions extends DefaultAzureCredentialOptions {
  scope: string | string[]
}

export interface DeveloperAzureCredentialOptions {
  scope: string | string[]
  abortSignal?: AbortSignal
}

// Azure CLI runs through the Windows shell, so scopes are limited to characters it doesn't interpret.
const safeCommandScope = /^[\w.:/-]+$/u

export async function getDefaultAzureCredentialToken(
  options: DefaultAzureCredentialTokenOptions,
): Promise<AccessToken> {
  const scopes = resolveRequiredScopes(options.scope)
  const tenantId = getEnv('AZURE_TENANT_ID')
  const clientId = getEnv('AZURE_CLIENT_ID')
  const clientSecret = getEnv('AZURE_CLIENT_SECRET')

  if (tenantId !== undefined && clientId !== undefined && clientSecret !== undefined) {
    return await getServicePrincipalToken({
      tenantId,
      clientId,
      clientSecret,
      scope: scopes,
      authorityHost: options.authorityHost,
      fetch: options.fetch,
    })
  }

  const [scope] = scopes
  if (scopes.length === 1 && scope?.endsWith('/.default') === true) {
    const managedIdentityToken = await unlessUnavailable(
      async () =>
        await getManagedIdentityToken({
          scope,
          clientId: options.managedIdentityClientId,
          fetch: options.fetch,
        }),
    )
    if (managedIdentityToken !== undefined) {
      return managedIdentityToken
    }
  }

  const developerToken = await unlessUnavailable(async () => await getDeveloperToken(scopes))
  if (developerToken !== undefined) {
    return developerToken
  }

  throw new TokenUnavailableError(
    'Could not find available credentials: environment service principal, managed identity, Azure CLI and Azure PowerShell are unavailable',
  )
}

export async function getDeveloperAzureCredentialToken(
  options: DeveloperAzureCredentialOptions,
): Promise<AccessToken> {
  options.abortSignal?.throwIfAborted()
  return await getDeveloperToken(resolveRequiredScopes(options.scope), options.abortSignal)
}

async function getDeveloperToken(scopes: string[], signal?: AbortSignal): Promise<AccessToken> {
  if (!hasCommandExecution()) {
    throw new TokenUnavailableError('Command execution is unavailable')
  }

  const cliToken = await unlessUnavailable(async () => await getAzureCliToken(scopes, signal))
  if (cliToken !== undefined) {
    return cliToken
  }

  const powerShellToken = await unlessUnavailable(
    async () => await getAzurePowerShellToken(scopes, signal),
  )
  if (powerShellToken !== undefined) {
    return powerShellToken
  }

  throw new TokenUnavailableError(
    'Could not find available developer credentials: Azure CLI and Azure PowerShell are unavailable',
  )
}

async function unlessUnavailable(
  acquire: () => Promise<AccessToken>,
): Promise<AccessToken | undefined> {
  try {
    return await acquire()
  } catch (error) {
    if (error instanceof TokenUnavailableError) {
      return undefined
    }

    throw error
  }
}

async function getAzureCliToken(scopes: string[], signal?: AbortSignal): Promise<AccessToken> {
  if (!scopes.every((scope) => safeCommandScope.test(scope))) {
    throw new TypeError(
      'Developer credential scopes may only contain letters, digits and _ . : / -',
    )
  }

  let output: string
  try {
    output = await executeCommand(
      'az',
      ['account', 'get-access-token', '--output', 'json', '--scope', ...scopes],
      { signal, shell: isWindows() },
    )
  } catch (error) {
    signal?.throwIfAborted()
    throw new TokenUnavailableError('Azure CLI is unavailable or not signed in', error)
  }

  return normalizeCommandToken(output)
}

async function getAzurePowerShellToken(
  scopes: string[],
  signal?: AbortSignal,
): Promise<AccessToken> {
  const [scope] = scopes
  if (scopes.length !== 1 || scope === undefined) {
    throw new TokenUnavailableError('Azure PowerShell requires exactly one scope')
  }

  const resource = scope.endsWith('/.default') ? scope.slice(0, -'/.default'.length) : scope
  // Az.Accounts 5 returns a SecureString token; NetworkCredential unwraps it on PowerShell 5.1 and 7.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$token = Get-AzAccessToken -ResourceUrl '${resource.replaceAll("'", "''")}'`,
    "$value = if ($token.Token -is [securestring]) { [System.Net.NetworkCredential]::new('', $token.Token).Password } else { $token.Token }",
    '@{ accessToken = $value; expiresOn = $token.ExpiresOn.ToUnixTimeSeconds() } | ConvertTo-Json -Compress',
  ].join('; ')

  try {
    return normalizeCommandToken(await runPowerShell(['pwsh', 'powershell'], script, signal))
  } catch (error) {
    signal?.throwIfAborted()
    throw new TokenUnavailableError(
      isCommandUnavailable(error)
        ? 'Azure PowerShell is unavailable'
        : 'Azure PowerShell token request failed',
      error,
    )
  }
}

/** Runs the script with the first PowerShell executable that exists. */
async function runPowerShell(
  [command = 'pwsh', ...fallbacks]: string[],
  script: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await executeCommand(
      command,
      ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', script],
      { signal },
    )
  } catch (error) {
    if (fallbacks.length > 0 && isCommandUnavailable(error)) {
      return await runPowerShell(fallbacks, script, signal)
    }

    throw error
  }
}
