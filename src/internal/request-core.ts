import type { TokenCredential } from '../types'
import { formatAuthorizationHeader } from './token'

export const storageOAuthScope = 'https://storage.azure.com/.default'
export const keyVaultOAuthScope = 'https://vault.azure.net/.default'
export const appConfigurationOAuthScope = 'https://appconfig.azure.com/.default'

interface HeaderCredential {
  getAuthorizationHeader: (scope?: string | string[]) => Promise<string>
}

export type AzureRequestCredential = HeaderCredential | TokenCredential

/** Signs the complete request, as App Configuration access keys require. */
export interface RequestSigningCredential {
  signRequest: (request: Request) => Promise<void>
}

export function resolveRequiredScopes(scope: string | string[]): string[] {
  const scopes = (Array.isArray(scope) ? scope : [scope])
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  if (scopes.length === 0) {
    throw new TypeError('At least one non-empty scope is required')
  }

  return scopes
}

export async function getAuthorizationHeader(
  credential: AzureRequestCredential,
  scope: string | string[],
): Promise<string> {
  if ('getAuthorizationHeader' in credential) {
    return await credential.getAuthorizationHeader(scope)
  }

  const token = await credential.getToken(resolveRequiredScopes(scope))
  if (token === null) {
    throw new Error('Unable to resolve a token from the configured credential')
  }

  return formatAuthorizationHeader(token)
}
