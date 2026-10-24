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
})
