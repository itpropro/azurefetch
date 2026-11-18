import { acquireDefaultAzureCredentialToken, defaultChainTenant } from './default-credential'
import type { DefaultAzureCredentialOptions } from './default-credential'
import { resolveRequiredScopes, storageOAuthScope } from './internal/request-core'
import { cacheToken, formatAuthorizationHeader } from './internal/token'
import type { CachedTokenRequest } from './internal/token'
import {
  challengeClaims,
  requireTenantId,
  selectTenant,
  tokenCacheKey,
} from './internal/token-options'
import { requireHttpsUrl } from './internal/url'
import type { AccessToken, GetTokenOptions } from './types'

export type { DefaultAzureCredentialOptions } from './default-credential'

interface ClaimsChallenge {
  claims: string
  tenantId: string | undefined
}

export class DefaultAzureCredential {
  private readonly options: DefaultAzureCredentialOptions
  private readonly tokens = new Map<
    string,
    (request: CachedTokenRequest<ClaimsChallenge>) => Promise<AccessToken>
  >()

  public constructor(options: DefaultAzureCredentialOptions = {}) {
    if (options.authorityHost !== undefined) {
      requireHttpsUrl(options.authorityHost, 'authorityHost')
    }
    this.options = options
  }

  public async getToken(
    scopes: string | string[],
    options: GetTokenOptions = {},
  ): Promise<AccessToken> {
    const scope = resolveRequiredScopes(scopes)
    const tenantId = options.tenantId === undefined ? undefined : requireTenantId(options.tenantId)
    const { enableCae } = options
    const claims = challengeClaims(options.claims)
    const key = tokenCacheKey(
      scope,
      selectTenant(defaultChainTenant(this.options), tenantId),
      enableCae,
    )
    let getToken = this.tokens.get(key)
    if (getToken === undefined) {
      getToken = cacheToken<ClaimsChallenge>(
        // Calls share this loader across equivalent tenants; a challenge brings its own call's tenant.
        async (signal, challenge) =>
          await acquireDefaultAzureCredentialToken(
            { ...this.options, scope },
            { tenantId, ...challenge, enableCae, signal },
          ),
      )
      this.tokens.set(key, getToken)
    }

    return await getToken({
      abortSignal: options.abortSignal,
      challenge: claims === undefined ? undefined : { claims, tenantId },
    })
  }

  public async getAuthorizationHeader(
    scopes: string | string[] = storageOAuthScope,
  ): Promise<string> {
    return formatAuthorizationHeader(await this.getToken(scopes))
  }
}
