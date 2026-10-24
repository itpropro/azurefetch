import type { AccessToken } from '../types'

const refreshSkewMs = 300_000

export function formatAuthorizationHeader(token: AccessToken): string {
  return `${token.tokenType ?? 'Bearer'} ${token.token}`
}

/** Reuses a token until it is due for refresh and shares one request between concurrent callers. */
export function cacheToken(loadToken: () => Promise<AccessToken>): () => Promise<AccessToken> {
  let cached: AccessToken | undefined
  let pending: Promise<AccessToken> | undefined

  return async () => {
    if (cached !== undefined && !isDueForRefresh(cached)) {
      return cached
    }

    if (pending !== undefined) {
      return await pending
    }

    pending = loadToken()
    try {
      cached = await pending
      return cached
    } finally {
      pending = undefined
    }
  }
}

function isDueForRefresh(token: AccessToken): boolean {
  const now = Date.now()
  return (
    now >= (token.refreshAfterTimestamp ?? Number.POSITIVE_INFINITY) ||
    now >= token.expiresOnTimestamp - refreshSkewMs
  )
}
