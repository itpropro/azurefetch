import type { AccessToken } from '../types'

const refreshSkewMs = 300_000
const failedRefreshCooldownMs = 30_000

export function formatAuthorizationHeader(token: AccessToken): string {
  return `${token.tokenType ?? 'Bearer'} ${token.token}`
}

/**
 * Reuses a token until it is due for refresh and shares one request between concurrent callers.
 * A failed refresh keeps an unexpired token and waits 30 s before trying again.
 */
export function cacheToken(loadToken: () => Promise<AccessToken>): () => Promise<AccessToken> {
  let cached: AccessToken | undefined
  let pending: Promise<AccessToken> | undefined
  let retryAfterTimestamp = 0

  const refresh = async (): Promise<AccessToken> => {
    try {
      cached = await loadToken()
      retryAfterTimestamp = 0
      return cached
    } catch (error) {
      if (cached === undefined || Date.now() >= cached.expiresOnTimestamp) {
        throw error
      }

      retryAfterTimestamp = Date.now() + failedRefreshCooldownMs
      return cached
    }
  }

  return async () => {
    if (cached !== undefined && isUsable(cached, retryAfterTimestamp)) {
      return cached
    }

    if (pending !== undefined) {
      return await pending
    }

    pending = refresh()
    try {
      return await pending
    } finally {
      pending = undefined
    }
  }
}

function isUsable(token: AccessToken, retryAfterTimestamp: number): boolean {
  const now = Date.now()
  return (
    now < token.expiresOnTimestamp && (now < retryAfterTimestamp || !isDueForRefresh(token, now))
  )
}

function isDueForRefresh(token: AccessToken, now: number): boolean {
  return (
    now >= (token.refreshAfterTimestamp ?? Number.POSITIVE_INFINITY) ||
    now >= token.expiresOnTimestamp - refreshSkewMs
  )
}
