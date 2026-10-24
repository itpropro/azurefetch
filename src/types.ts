export interface AccessToken {
  token: string
  tokenType?: 'Bearer' | 'pop'
  expiresOnTimestamp: number
  refreshAfterTimestamp?: number
}

/** The structural signal Azure SDK clients pass; a native `AbortSignal` satisfies it. */
export interface AbortSignalLike {
  readonly aborted: boolean
  readonly reason?: unknown
  addEventListener: (type: 'abort', listener: (event: unknown) => void) => void
  removeEventListener: (type: 'abort', listener: (event: unknown) => void) => void
}

/** The second `getToken` argument of `@azure/core-auth`, limited to the options credentials honor. */
export interface GetTokenOptions {
  abortSignal?: AbortSignalLike
  /** Tenant for this request; other tenants must be listed in `additionallyAllowedTenants`. */
  tenantId?: string
  /** JSON claims challenge from a resource; it bypasses the token cache. */
  claims?: string
  /** Requests a token for continuous access evaluation. */
  enableCae?: boolean
}

export interface TokenCredential {
  getToken: (scopes: string | string[], options?: GetTokenOptions) => Promise<AccessToken | null>
}
