import { resolveRequiredScopes } from './internal/request-core'
import type { RetryOptions } from './internal/request-core'
import { cacheToken } from './internal/token'
import type { CachedTokenRequest } from './internal/token'
import { challengeClaims, resolveTenant, tokenCacheKey } from './internal/token-options'
import { getServicePrincipalToken } from './service-principal'
import type { ServicePrincipalOptions } from './service-principal'
import type { AccessToken, GetTokenOptions } from './types'

export interface ClientSecretCredentialOptions {
  authorityHost?: string
  /** Tenants besides `tenantId` that `getToken` may request; `*` allows any tenant. */
  additionallyAllowedTenants?: string[]
  retryOptions?: RetryOptions
  fetch?: typeof globalThis.fetch
}

/** Class form of `getServicePrincipalToken` with per-scope token caching. */
export class ClientSecretCredential {
  // ES private, so the secret stays out of logs and serialization.
  readonly #options: Omit<ServicePrincipalOptions, 'scope'>
  readonly #additionallyAllowedTenants: string[]
  readonly #tokens = new Map<
    string,
    (request: CachedTokenRequest<string>) => Promise<AccessToken>
  >()

  public constructor(
    tenantId: string,
    clientId: string,
    clientSecret: string,
    { additionallyAllowedTenants = [], ...options }: ClientSecretCredentialOptions = {},
  ) {
    this.#options = { ...options, tenantId, clientId, clientSecret }
    this.#additionallyAllowedTenants = additionallyAllowedTenants
  }

  public async getToken(
    scopes: string | string[],
    options: GetTokenOptions = {},
  ): Promise<AccessToken> {
    const scope = resolveRequiredScopes(scopes)
    const tenantId =
      resolveTenant(this.#options.tenantId, options.tenantId, this.#additionallyAllowedTenants) ??
      this.#options.tenantId
    const { enableCae } = options
    const key = tokenCacheKey(scope, tenantId, enableCae)
    let getToken = this.#tokens.get(key)
    if (getToken === undefined) {
      getToken = cacheToken<string>(
        async (abortSignal, claims) =>
          await getServicePrincipalToken({
            ...this.#options,
            tenantId,
            scope,
            abortSignal,
            claims,
            enableCae,
          }),
      )
      this.#tokens.set(key, getToken)
    }

    return await getToken({
      abortSignal: options.abortSignal,
      challenge: challengeClaims(options.claims),
    })
  }
}
