import { getDefaultAzureCredentialToken } from './default-credential'
import type { DefaultAzureCredentialOptions } from './default-credential'
import { resolveRequiredScopes, storageOAuthScope } from './internal/request-core'
import { cacheToken, formatAuthorizationHeader } from './internal/token'
import { requireHttpsUrl } from './internal/url'
import type { AccessToken } from './types'

export type { DefaultAzureCredentialOptions } from './default-credential'

export class DefaultAzureCredential {
  private readonly options: DefaultAzureCredentialOptions
  private readonly tokens = new Map<string, () => Promise<AccessToken>>()

  public constructor(options: DefaultAzureCredentialOptions = {}) {
    if (options.authorityHost !== undefined) {
      requireHttpsUrl(options.authorityHost, 'authorityHost')
    }
    this.options = options
  }

  public async getToken(scopes: string | string[]): Promise<AccessToken> {
    const scope = resolveRequiredScopes(scopes)
    const key = scope.join(' ')
    let getToken = this.tokens.get(key)
    if (getToken === undefined) {
      getToken = cacheToken(
        async () =>
          await getDefaultAzureCredentialToken({
            ...this.options,
            scope: scope.length === 1 ? (scope[0] ?? scope) : scope,
          }),
      )
      this.tokens.set(key, getToken)
    }

    return await getToken()
  }

  public async getAuthorizationHeader(
    scopes: string | string[] = storageOAuthScope,
  ): Promise<string> {
    return formatAuthorizationHeader(await this.getToken(scopes))
  }
}
