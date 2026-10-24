import type { AbortSignalLike, AccessToken } from '../types'

const refreshSkewMs = 300_000
const failedRefreshCooldownMs = 30_000
const aborted = Symbol('aborted')

export interface CachedTokenRequest<Challenge> {
  abortSignal?: AbortSignalLike
  /** A claims challenge always sends its own request and never falls back to the cached token. */
  challenge?: Challenge
}

export type LoadToken<Challenge> = (
  signal: AbortSignal,
  challenge?: Challenge,
) => Promise<AccessToken>

export function formatAuthorizationHeader(token: AccessToken): string {
  return `${token.tokenType ?? 'Bearer'} ${token.token}`
}

export function abortReason(signal: AbortSignalLike): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

/** One token request that callers join; it is cancelled once every waiting caller has aborted. */
class Acquisition {
  readonly #controller = new AbortController()
  readonly #promise: Promise<AccessToken>
  #settled = false
  #waiters = 0

  public constructor(load: (signal: AbortSignal) => Promise<AccessToken>) {
    this.#promise = this.#run(load)
  }

  public isJoinable(): boolean {
    return !this.#settled && !this.#controller.signal.aborted
  }

  public async join(signal: AbortSignalLike | undefined): Promise<AccessToken> {
    this.#waiters += 1
    if (signal === undefined) {
      return await this.#promise
    }

    const abort = listenForAbort(signal, () => {
      this.#waiters -= 1
      if (this.#waiters === 0) {
        this.#controller.abort()
      }
    })
    try {
      const result = await Promise.race([this.#promise, abort.promise])
      if (result === aborted) {
        throw abortReason(signal)
      }

      return result
    } finally {
      abort.remove()
    }
  }

  async #run(load: (signal: AbortSignal) => Promise<AccessToken>): Promise<AccessToken> {
    try {
      return await load(this.#controller.signal)
    } finally {
      this.#settled = true
    }
  }
}

/**
 * Reuses a token until it is due for refresh and shares one request between concurrent callers.
 * A failed refresh keeps an unexpired token and waits 30 s before trying again. Cancellation only
 * rejects the aborting caller.
 */
export function cacheToken<Challenge>(
  loadToken: LoadToken<Challenge>,
): (request?: CachedTokenRequest<Challenge>) => Promise<AccessToken> {
  let cached: AccessToken | undefined
  let cachedOrder = 0
  let started = 0
  let retryAfterTimestamp = 0
  let pending: Acquisition | undefined

  const acquire = (challenge: Challenge | undefined): Acquisition => {
    started += 1
    const order = started
    return new Acquisition(async (signal) => {
      let token: AccessToken
      try {
        token = await loadToken(signal, challenge)
      } catch (error) {
        if (
          challenge !== undefined ||
          signal.aborted ||
          cached === undefined ||
          Date.now() >= cached.expiresOnTimestamp
        ) {
          throw error
        }

        retryAfterTimestamp = Date.now() + failedRefreshCooldownMs
        return cached
      }

      // A refresh that started before the cached token, such as a claims result, must not replace it.
      if (order > cachedOrder) {
        cached = token
        cachedOrder = order
        retryAfterTimestamp = 0
      }
      return token
    })
  }

  return async ({ abortSignal, challenge } = {}) => {
    if (abortSignal?.aborted === true) {
      throw abortReason(abortSignal)
    }

    if (challenge !== undefined) {
      return await acquire(challenge).join(abortSignal)
    }

    if (cached !== undefined && isUsable(cached, retryAfterTimestamp)) {
      return cached
    }

    if (pending?.isJoinable() !== true) {
      pending = acquire(undefined)
    }
    return await pending.join(abortSignal)
  }
}

function listenForAbort(
  signal: AbortSignalLike,
  onAbort: () => void,
): { promise: Promise<typeof aborted>; remove: () => void } {
  let listener: (() => void) | undefined
  const promise = new Promise<typeof aborted>((resolve) => {
    listener = () => {
      onAbort()
      resolve(aborted)
    }
    signal.addEventListener('abort', listener)
  })

  return {
    promise,
    remove: () => {
      if (listener !== undefined) {
        signal.removeEventListener('abort', listener)
      }
    },
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
