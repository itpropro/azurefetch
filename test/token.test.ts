import { afterEach, describe, expect, test, vi } from 'vitest'

import { cacheToken } from '../src/internal/token'
import type { AccessToken } from '../src/types'

function tokenLoader(lifetimeMs: number, refreshInMs?: number) {
  let count = 0
  return vi.fn<() => Promise<AccessToken>>(async () => {
    count += 1
    return {
      token: `token-${count}`,
      expiresOnTimestamp: Date.now() + lifetimeMs,
      refreshAfterTimestamp: refreshInMs === undefined ? undefined : Date.now() + refreshInMs,
    }
  })
}

/** A refresh that fails after taking `durationMs`. */
function failsAfter(durationMs: number, error: Error): () => Promise<AccessToken> {
  return async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, durationMs)
    })
    throw error
  }
}

describe('cacheToken', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('reuses a token until five minutes before it expires', async () => {
    vi.useFakeTimers({ now: 0 })
    const getToken = cacheToken(tokenLoader(600_000))

    expect((await getToken()).token).toBe('token-1')
    vi.setSystemTime(299_999)
    expect((await getToken()).token).toBe('token-1')
    vi.setSystemTime(300_000)
    expect((await getToken()).token).toBe('token-2')
  })

  test('refreshes at refreshAfterTimestamp even when the token is far from expiry', async () => {
    vi.useFakeTimers({ now: 0 })
    const getToken = cacheToken(tokenLoader(3_600_000, 60_000))

    expect((await getToken()).token).toBe('token-1')
    vi.setSystemTime(60_000)
    expect((await getToken()).token).toBe('token-2')
  })

  test('shares one request between concurrent callers', async () => {
    const loadToken = tokenLoader(600_000)
    const getToken = cacheToken(loadToken)

    const tokens = await Promise.all([getToken(), getToken()])

    expect(tokens.map(({ token }) => token)).toStrictEqual(['token-1', 'token-1'])
    expect(loadToken).toHaveBeenCalledTimes(1)
  })

  test('requests a new token after a failed request', async () => {
    const loadToken = tokenLoader(600_000)
    loadToken.mockRejectedValueOnce(new Error('first failure'))
    const getToken = cacheToken(loadToken)

    await expect(getToken()).rejects.toThrow('first failure')
    await expect(getToken()).resolves.toMatchObject({ token: 'token-1' })
  })

  describe('when a refresh fails', () => {
    const refreshFailure = new Error('refresh failed')

    test('returns the unexpired token to every waiting caller', async () => {
      vi.useFakeTimers({ now: 0 })
      const loadToken = tokenLoader(600_000)
      const getToken = cacheToken(loadToken)
      await getToken()
      loadToken.mockImplementationOnce(failsAfter(1000, refreshFailure))

      vi.setSystemTime(300_000)
      const tokens = Promise.all([getToken(), getToken()])
      await vi.advanceTimersByTimeAsync(1000)

      await expect(tokens).resolves.toMatchObject([{ token: 'token-1' }, { token: 'token-1' }])
      expect(loadToken).toHaveBeenCalledTimes(2)
    })

    test('returns the unexpired token after a refresh that refreshAfterTimestamp triggered', async () => {
      vi.useFakeTimers({ now: 0 })
      const loadToken = tokenLoader(3_600_000, 60_000)
      const getToken = cacheToken(loadToken)
      await getToken()
      loadToken.mockRejectedValueOnce(refreshFailure)

      vi.setSystemTime(60_000)
      expect((await getToken()).token).toBe('token-1')
    })

    test('waits 30 s from the failure before refreshing again', async () => {
      vi.useFakeTimers({ now: 0 })
      const loadToken = tokenLoader(600_000)
      const getToken = cacheToken(loadToken)
      await getToken()
      loadToken.mockRejectedValueOnce(refreshFailure)
      vi.setSystemTime(300_000)
      await getToken()

      vi.setSystemTime(310_000)
      expect((await getToken()).token).toBe('token-1')
      vi.setSystemTime(329_999)
      expect((await getToken()).token).toBe('token-1')
      expect(loadToken).toHaveBeenCalledTimes(2)

      vi.setSystemTime(330_000)
      expect((await getToken()).token).toBe('token-2')
      vi.setSystemTime(340_000)
      expect((await getToken()).token).toBe('token-2')
      expect(loadToken).toHaveBeenCalledTimes(3)
    })

    test('refreshes at expiry during the wait and rejects when that refresh fails', async () => {
      vi.useFakeTimers({ now: 0 })
      const loadToken = tokenLoader(600_000)
      const getToken = cacheToken(loadToken)
      await getToken()
      loadToken.mockRejectedValueOnce(refreshFailure)
      vi.setSystemTime(590_000)
      await getToken()

      loadToken.mockRejectedValueOnce(refreshFailure)
      vi.setSystemTime(600_000)
      await expect(getToken()).rejects.toBe(refreshFailure)
      expect(loadToken).toHaveBeenCalledTimes(3)
    })

    test('rejects every waiting caller when the token expires before the refresh fails', async () => {
      vi.useFakeTimers({ now: 0 })
      const loadToken = tokenLoader(600_000)
      const getToken = cacheToken(loadToken)
      await getToken()
      loadToken.mockImplementationOnce(failsAfter(10_000, refreshFailure))

      vi.setSystemTime(590_000)
      const results = Promise.allSettled([getToken(), getToken()])
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(results).resolves.toStrictEqual([
        { status: 'rejected', reason: refreshFailure },
        { status: 'rejected', reason: refreshFailure },
      ])
      await expect(getToken()).resolves.toMatchObject({ token: 'token-2' })
    })
  })
})
