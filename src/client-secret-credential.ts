import { resolveRequiredScopes } from './internal/request-core'
import { cacheToken } from './internal/token'
import { getServicePrincipalToken } from './service-principal'
import type { ServicePrincipalOptions } from './service-principal'
import type { AccessToken } from './types'

export interface ClientSecretCredentialOptions {
  authorityHost?: string
  fetch?: typeof globalThis.fetch
}

/** Class form of `getServicePrincipalToken` with per-scope token caching. */
export class ClientSecretCredential {
  // ES private, so the secret stays out of logs and serialization.
  readonly #options: Omit<ServicePrincipalOptions, 'scope'>
  readonly #tokens = new Map<string, () => Promise<AccessToken>>()

  public constructor(
    tenantId: string,
    clientId: string,
    clientSecret: string,
    options: ClientSecretCredentialOptions = {},
  ) {
    this.#options = { ...options, tenantId, clientId, clientSecret }
  }

  public async getToken(scopes: string | string[]): Promise<AccessToken> {
    const scope = resolveRequiredScopes(scopes)
    const key = scope.join(' ')
    let getToken = this.#tokens.get(key)
    if (getToken === undefined) {
      getToken = cacheToken(async () => await getServicePrincipalToken({ ...this.#options, scope }))
      this.#tokens.set(key, getToken)
    }

    return await getToken()
  }
}
