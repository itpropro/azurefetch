import { createClientAssertion, loadClientCertificate } from './internal/client-certificate'
import { fetchJson, normalizeCommandToken, normalizeToken } from './internal/oauth'
import { resolveRequiredScopes } from './internal/request-core'
import type { RetryOptions } from './internal/request-core'
import {
  defaultFetch,
  executeCommand,
  getEnv,
  getRawEnv,
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
  /** Retries of token requests; managed identity on IMDS has its own defaults. */
  retryOptions?: RetryOptions
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
const jwtBearerAssertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const enabledFlag = /^(?:true|1)$/iu

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
  const environmentToken = await getEnvironmentToken(scopes, options, request)
  if (environmentToken !== undefined) {
    return environmentToken
  }

  const tenantId = getEnv('AZURE_TENANT_ID')
  const clientId = getEnv('AZURE_CLIENT_ID')

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
          clientId: options.managedIdentityClientId ?? clientId,
          abortSignal: signal,
          retryOptions: options.retryOptions,
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

/**
 * The environment credential of `@azure/identity`: a client secret, then a certificate, then a
 * username and password. A configured source ends the chain, also when it refuses the tenant.
 */
async function getEnvironmentToken(
  scopes: string[],
  options: DefaultAzureCredentialOptions,
  request: ChainRequest,
): Promise<AccessToken | undefined> {
  const configuredTenantId = getEnv('AZURE_TENANT_ID')
  const clientId = getEnv('AZURE_CLIENT_ID')
  if (configuredTenantId === undefined || clientId === undefined) {
    return undefined
  }

  const tenantId = (): string =>
    resolveTenant(
      configuredTenantId,
      request.tenantId,
      options.additionallyAllowedTenants ?? environmentAllowedTenants(),
    ) ?? configuredTenantId
  const clientSecret = getEnv('AZURE_CLIENT_SECRET')
  if (clientSecret !== undefined) {
    return await getServicePrincipalToken({
      tenantId: tenantId(),
      clientId,
      clientSecret,
      scope: scopes,
      authorityHost: options.authorityHost,
      abortSignal: request.signal,
      claims: request.claims,
      enableCae: request.enableCae,
      retryOptions: options.retryOptions,
      fetch: options.fetch,
    })
  }

  const certificatePath = getEnv('AZURE_CLIENT_CERTIFICATE_PATH')
  if (certificatePath !== undefined) {
    const url = tokenEndpoint(options, tenantId())
    const certificate = await loadClientCertificate(
      await readTextFile(certificatePath),
      getRawEnv('AZURE_CLIENT_CERTIFICATE_PASSWORD'),
    )
    const assertion = await createClientAssertion(certificate, {
      clientId,
      audience: url,
      sendCertificateChain: enabledFlag.test(getEnv('AZURE_CLIENT_SEND_CERTIFICATE_CHAIN') ?? ''),
    })
    return await requestFormToken(
      url,
      {
        client_id: clientId,
        client_assertion: assertion,
        client_assertion_type: jwtBearerAssertionType,
        grant_type: 'client_credentials',
      },
      scopes,
      options,
      request,
    )
  }

  const username = getEnv('AZURE_USERNAME')
  const password = getRawEnv('AZURE_PASSWORD')
  if (username !== undefined && password !== undefined) {
    // Accounts that require MFA can't use this grant; Entra's error reaches the caller unchanged.
    return await requestFormToken(
      tokenEndpoint(options, tenantId()),
      { client_id: clientId, grant_type: 'password', username, password },
      scopes,
      options,
      request,
    )
  }

  return undefined
}

async function getWorkloadIdentityToken(
  tenantId: string,
  clientId: string,
  tokenFile: string,
  scopes: string[],
  options: DefaultAzureCredentialOptions,
  request: ChainRequest,
): Promise<AccessToken> {
  // Kubernetes rotates the projected token in place, so read it for every request.
  const assertion = (await readTextFile(tokenFile)).trim()
  return await requestFormToken(
    tokenEndpoint(options, tenantId),
    {
      client_id: clientId,
      client_assertion: assertion,
      client_assertion_type: jwtBearerAssertionType,
      grant_type: 'client_credentials',
    },
    scopes,
    options,
    request,
  )
}

function tokenEndpoint(options: DefaultAzureCredentialOptions, tenantId: string): string {
  const authorityHost = sanitizeAuthorityHost(
    options.authorityHost ?? 'https://login.microsoftonline.com',
  )
  return `${authorityHost}/${tenantId}/oauth2/v2.0/token`
}

/** Posts an OAuth token request with the per-call claims, cancellation and retries. */
async function requestFormToken(
  url: string,
  form: Record<string, string>,
  scopes: string[],
  options: DefaultAzureCredentialOptions,
  { claims, enableCae, signal }: ChainRequest,
): Promise<AccessToken> {
  const requestClaims = tokenRequestClaims(claims, enableCae)
  const payload = await fetchJson(
    url,
    {
      method: 'POST',
      body: new URLSearchParams({
        ...form,
        scope: scopes.join(' '),
        ...(requestClaims === undefined ? {} : { claims: requestClaims }),
      }),
      signal,
    },
    options.fetch ?? defaultFetch,
    options.retryOptions,
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
