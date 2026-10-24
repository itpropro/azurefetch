import { fetchJson, normalizeCommandToken, normalizeToken } from './internal/oauth'
import { resolveRequiredScopes } from './internal/request-core'
import {
  defaultFetch,
  executeCommand,
  getEnv,
  hasCommandExecution,
  isCommandUnavailable,
  isWindows,
  readTextFile,
} from './internal/runtime'
import {
  claimsLoginInstructions,
  environmentAllowedTenants,
  requireTenantId,
  resolveTenant,
  tokenRequestClaims,
} from './internal/token-options'
import { sanitizeAuthorityHost } from './internal/url'
import { getManagedIdentityToken } from './managed-identity'
import { getServicePrincipalToken } from './service-principal'
import { TokenUnavailableError } from './token-unavailable-error'
import type { AccessToken } from './types'

export interface DefaultAzureCredentialOptions {
  authorityHost?: string
  /** Tenant for workload identity, Azure CLI and Azure PowerShell. */
  tenantId?: string
  /**
   * Tenants besides the configured one that `getToken` may request; `*` allows any tenant.
   * The environment service principal falls back to AZURE_ADDITIONALLY_ALLOWED_TENANTS.
   */
  additionallyAllowedTenants?: string[]
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

/** Per-call options of one chain run; the credential has validated the tenant. */
export interface ChainRequest {
  tenantId?: string
  claims?: string
  enableCae?: boolean
  signal?: AbortSignal
}

// Azure CLI runs through the Windows shell, so scopes are limited to characters it doesn't interpret.
const safeCommandScope = /^[\w.:/-]+$/u

export async function getDefaultAzureCredentialToken(
  options: DefaultAzureCredentialTokenOptions,
): Promise<AccessToken> {
  return await acquireDefaultAzureCredentialToken(options, {})
}

export async function acquireDefaultAzureCredentialToken(
  options: DefaultAzureCredentialTokenOptions,
  request: ChainRequest,
): Promise<AccessToken> {
  const scopes = resolveRequiredScopes(options.scope)
  if (options.tenantId !== undefined) {
    requireTenantId(options.tenantId)
  }

  const { signal } = request
  const tenantId = getEnv('AZURE_TENANT_ID')
  const clientId = getEnv('AZURE_CLIENT_ID')
  const clientSecret = getEnv('AZURE_CLIENT_SECRET')

  // A configured environment service principal ends the chain, also when it refuses the tenant.
  if (tenantId !== undefined && clientId !== undefined && clientSecret !== undefined) {
    const allowedTenants = options.additionallyAllowedTenants ?? environmentAllowedTenants()
    return await getServicePrincipalToken({
      tenantId: resolveTenant(tenantId, request.tenantId, allowedTenants) ?? tenantId,
      clientId,
      clientSecret,
      scope: scopes,
      authorityHost: options.authorityHost,
      abortSignal: signal,
      claims: request.claims,
      enableCae: request.enableCae,
      fetch: options.fetch,
    })
  }

  // The AKS workload identity webhook also sets AZURE_CLIENT_ID, so this must run before managed identity.
  const workloadTenantId = options.tenantId ?? tenantId
  const workloadClientId = options.managedIdentityClientId ?? clientId
  const federatedTokenFile = getEnv('AZURE_FEDERATED_TOKEN_FILE')
  if (
    workloadTenantId !== undefined &&
    workloadClientId !== undefined &&
    federatedTokenFile !== undefined
  ) {
    const workloadToken = await unlessUnavailable(
      async () =>
        await getWorkloadIdentityToken(
          resolveTenant(workloadTenantId, request.tenantId, options.additionallyAllowedTenants) ??
            workloadTenantId,
          workloadClientId,
          federatedTokenFile,
          scopes,
          options,
          request,
        ),
      signal,
    )
    if (workloadToken !== undefined) {
      return workloadToken
    }
  }

  const [scope] = scopes
  if (scopes.length === 1 && scope?.endsWith('/.default') === true) {
    const managedIdentityToken = await unlessUnavailable(
      async () =>
        await getManagedIdentityToken({
          scope,
          clientId: options.managedIdentityClientId,
          abortSignal: signal,
          fetch: options.fetch,
        }),
      signal,
    )
    if (managedIdentityToken !== undefined) {
      return managedIdentityToken
    }
  }

  if (request.claims !== undefined) {
    throw new TokenUnavailableError(
      `Could not find available credentials. ${claimsLoginInstructions(request.claims, scopes, request.tenantId)}`,
    )
  }

  const developerToken = await unlessUnavailable(
    async () =>
      await getDeveloperToken(
        scopes,
        signal,
        resolveTenant(options.tenantId, request.tenantId, options.additionallyAllowedTenants),
      ),
    signal,
  )
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

async function getDeveloperToken(
  scopes: string[],
  signal?: AbortSignal,
  tenantId?: string,
): Promise<AccessToken> {
  if (!hasCommandExecution()) {
    throw new TokenUnavailableError('Command execution is unavailable')
  }

  const cliToken = await unlessUnavailable(
    async () => await getAzureCliToken(scopes, signal, tenantId),
    signal,
  )
  if (cliToken !== undefined) {
    return cliToken
  }

  const powerShellToken = await unlessUnavailable(
    async () => await getAzurePowerShellToken(scopes, signal, tenantId),
    signal,
  )
  if (powerShellToken !== undefined) {
    return powerShellToken
  }

  throw new TokenUnavailableError(
    'Could not find available developer credentials: Azure CLI and Azure PowerShell are unavailable',
  )
}

async function getWorkloadIdentityToken(
  tenantId: string,
  clientId: string,
  tokenFile: string,
  scopes: string[],
  options: DefaultAzureCredentialOptions,
  { claims, enableCae, signal }: ChainRequest,
): Promise<AccessToken> {
  const requestClaims = tokenRequestClaims(claims, enableCae)
  // Kubernetes rotates the projected token in place, so read it for every request.
  const assertion = (await readTextFile(tokenFile)).trim()
  const authorityHost = sanitizeAuthorityHost(
    options.authorityHost ?? 'https://login.microsoftonline.com',
  )
  const payload = await fetchJson(
    `${authorityHost}/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientId,
        client_assertion: assertion,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        grant_type: 'client_credentials',
        scope: scopes.join(' '),
        ...(requestClaims === undefined ? {} : { claims: requestClaims }),
      }),
      signal,
    },
    options.fetch ?? defaultFetch,
  )

  return normalizeToken(payload)
}

async function unlessUnavailable(
  acquire: () => Promise<AccessToken>,
  signal: AbortSignal | undefined,
): Promise<AccessToken | undefined> {
  try {
    return await acquire()
  } catch (error) {
    // A cancelled request must not move on to the next credential.
    signal?.throwIfAborted()
    if (error instanceof TokenUnavailableError) {
      return undefined
    }

    throw error
  }
}

async function getAzureCliToken(
  scopes: string[],
  signal?: AbortSignal,
  tenantId?: string,
): Promise<AccessToken> {
  if (!scopes.every((scope) => safeCommandScope.test(scope))) {
    throw new TypeError(
      'Developer credential scopes may only contain letters, digits and _ . : / -',
    )
  }

  let output: string
  try {
    output = await executeCommand(
      'az',
      [
        'account',
        'get-access-token',
        '--output',
        'json',
        '--scope',
        ...scopes,
        ...(tenantId === undefined ? [] : ['--tenant', tenantId]),
      ],
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
  tenantId?: string,
): Promise<AccessToken> {
  const [scope] = scopes
  if (scopes.length !== 1 || scope === undefined) {
    throw new TokenUnavailableError('Azure PowerShell requires exactly one scope')
  }

  const resource = scope.endsWith('/.default') ? scope.slice(0, -'/.default'.length) : scope
  const tenantArgument = tenantId === undefined ? '' : ` -TenantId '${tenantId}'`
  // Az.Accounts 5 returns a SecureString token; NetworkCredential unwraps it on PowerShell 5.1 and 7.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$token = Get-AzAccessToken -ResourceUrl '${resource.replaceAll("'", "''")}'${tenantArgument}`,
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
