import { fetchJson, normalizeToken } from './internal/oauth'
import { resolveRequiredScopes } from './internal/request-core'
import { defaultFetch } from './internal/runtime'
import { sanitizeAuthorityHost } from './internal/url'
import { TokenRequestError } from './token-request-error'
import type { AccessToken } from './types'

export interface ServicePrincipalOptions {
  tenantId: string
  clientId: string
  clientSecret: string
  scope: string | string[]
  authorityHost?: string
  abortSignal?: AbortSignal
  fetch?: typeof globalThis.fetch
}

export async function getServicePrincipalToken(
  options: ServicePrincipalOptions,
): Promise<AccessToken> {
  const { tenantId, clientId, clientSecret, abortSignal } = options
  for (const [name, value] of Object.entries({ tenantId, clientId, clientSecret })) {
    if (value.length === 0) {
      throw new TypeError(`${name} is required`)
    }
  }

  const scopes = resolveRequiredScopes(options.scope)
  const authorityHost = sanitizeAuthorityHost(
    options.authorityHost ?? 'https://login.microsoftonline.com',
  )
  abortSignal?.throwIfAborted()

  let payload: unknown
  try {
    payload = await fetchJson(
      `${authorityHost}/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
          scope: scopes.join(' '),
        }),
        signal: abortSignal,
      },
      options.fetch ?? defaultFetch,
    )
  } catch (error) {
    abortSignal?.throwIfAborted()
    if (error instanceof TokenRequestError) {
      throw error
    }

    throw new TokenRequestError(
      'Failed to request service principal token',
      undefined,
      undefined,
      error,
    )
  }

  return normalizeToken(payload)
}
