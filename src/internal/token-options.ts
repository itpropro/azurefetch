import { TokenUnavailableError } from '../token-unavailable-error'
import { jsonProperty } from './json'
import { getEnv } from './runtime'
import { encodeBytesToBase64, encodeUtf8 } from './storage-encoding'

// The tenant also reaches URLs, the Windows shell and a PowerShell script.
const safeTenantId = /^[\w.-]+$/u

export function requireTenantId(tenantId: string): string {
  if (!safeTenantId.test(tenantId)) {
    throw new TypeError('tenantId may only contain letters, digits and _ . -')
  }

  return tenantId
}

/**
 * Picks the tenant of one token request. A per-call tenant other than the configured one must be
 * allowed, unless multi-tenant authentication is disabled or the configured tenant is ADFS.
 */
export function resolveTenant(
  configured: string | undefined,
  requested: string | undefined,
  allowed: readonly string[] = [],
): string | undefined {
  const tenant = selectTenant(configured, requested)
  if (tenant === undefined) {
    return undefined
  }

  requireTenantId(tenant)
  if (
    configured !== undefined &&
    tenant !== configured &&
    !allowed.includes('*') &&
    !allowed.includes(tenant)
  ) {
    throw new TokenUnavailableError(
      `The credential is not configured to acquire tokens for tenant ${tenant}. Add it to additionallyAllowedTenants, or add "*" to allow any tenant.`,
    )
  }

  return tenant
}

/** The tenant a request uses before the allowlist check; it also keys token caches. */
export function selectTenant(
  configured: string | undefined,
  requested: string | undefined,
): string | undefined {
  return requested === undefined ||
    configured === 'adfs' ||
    getEnv('AZURE_IDENTITY_DISABLE_MULTITENANTAUTH') !== undefined
    ? configured
    : requested
}

/** Tenants the environment credential may serve besides AZURE_TENANT_ID, separated by semicolons. */
export function environmentAllowedTenants(): string[] {
  return getEnv('AZURE_ADDITIONALLY_ALLOWED_TENANTS')?.split(';') ?? []
}

/** A blank claims challenge is no challenge. */
export function challengeClaims(claims: string | undefined): string | undefined {
  return claims?.trim() === '' ? undefined : claims
}

/** The `claims` parameter of a token request; CAE adds the `cp1` client capability. */
export function tokenRequestClaims(
  claims: string | undefined,
  enableCae: boolean | undefined,
): string | undefined {
  if (enableCae !== true) {
    return claims
  }

  const challenge: unknown = claims === undefined ? {} : JSON.parse(claims)
  if (typeof challenge !== 'object' || challenge === null || Array.isArray(challenge)) {
    throw new TypeError('claims must be a JSON object')
  }

  const accessToken = jsonProperty(challenge, 'access_token')
  return JSON.stringify({
    ...challenge,
    access_token: {
      ...(typeof accessToken === 'object' && accessToken !== null ? accessToken : {}),
      xms_cc: { values: ['cp1'] },
    },
  })
}

export function tokenCacheKey(
  scopes: string[],
  tenantId: string | undefined,
  enableCae: boolean | undefined,
): string {
  return JSON.stringify([scopes, tenantId ?? null, enableCae === true])
}

/** Developer credentials can't answer a claims challenge; the user has to sign in again. */
export function claimsLoginInstructions(
  claims: string,
  scopes: string[],
  tenantId: string | undefined,
): string {
  const encoded = encodeBytesToBase64(encodeUtf8(claims))
  const azureCli = `az login --claims-challenge ${encoded} --scope ${scopes.join(' ')}${tenantId === undefined ? '' : ` --tenant ${tenantId}`}`
  const powerShell = `Connect-AzAccount -ClaimsChallenge ${encoded}${tenantId === undefined ? '' : ` -Tenant ${tenantId}`}`
  return `Azure CLI and Azure PowerShell don't support claims challenges. To authenticate with the required claims, run ${azureCli} or ${powerShell}`
}
