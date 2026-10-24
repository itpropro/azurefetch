import { acquireDefaultAzureCredentialToken } from './default-credential'
import type { DefaultAzureCredentialOptions } from './default-credential'
import { resolveRequiredScopes, storageOAuthScope } from './internal/request-core'
import { cacheToken, formatAuthorizationHeader } from './internal/token'
import type { CachedTokenRequest } from './internal/token'
import { challengeClaims, requireTenantId, tokenCacheKey } from './internal/token-options'
import { requireHttpsUrl } from './internal/url'
import type { AccessToken, GetTokenOptions } from './types'

export type { DefaultAzureCredentialOptions } from './default-credential'

export class DefaultAzureCredential {
  private readonly options: DefaultAzureCredentialOptions
  private readonly tokens = new Map<string, (request: CachedTokenRequest) => Promise<AccessToken>>()

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
    const key = tokenCacheKey(scope, tenantId, enableCae)
    let getToken = this.tokens.get(key)
    if (getToken === undefined) {
      getToken = cacheToken(
        async (signal, claims) =>
          await acquireDefaultAzureCredentialToken(
            { ...this.options, scope },
            { tenantId, claims, enableCae, signal },
          ),
      )
      this.tokens.set(key, getToken)
    }

    return await getToken({
      abortSignal: options.abortSignal,
      claims: challengeClaims(options.claims),
    })
  }

  public async getAuthorizationHeader(
    scopes: string | string[] = storageOAuthScope,
  ): Promise<string> {
    return formatAuthorizationHeader(await this.getToken(scopes))
  }
}
