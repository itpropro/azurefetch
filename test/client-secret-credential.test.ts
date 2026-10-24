import { inspect } from 'node:util'

import { describe, expect, test } from 'vitest'

import { ClientSecretCredential } from '../src/client-secret-credential'
import { createFetchMock, getBodyString, jsonResponse } from './helpers'

const tokenForRequestedScope = (_url: string, init: RequestInit) =>
  jsonResponse({
    access_token: new URLSearchParams(getBodyString(init.body)).get('scope'),
    expires_in: 3600,
  })

describe('ClientSecretCredential', () => {
  test('caches service principal tokens separately per scope', async () => {
    const fetchMock = createFetchMock([tokenForRequestedScope, tokenForRequestedScope])
    const credential = new ClientSecretCredential('tenant', 'client', 'secret', {
      fetch: fetchMock,
    })

    await expect(credential.getToken('a/.default')).resolves.toMatchObject({ token: 'a/.default' })
    await expect(credential.getToken(['a/.default'])).resolves.toMatchObject({
      token: 'a/.default',
    })
    await expect(credential.getToken('b/.default')).resolves.toMatchObject({ token: 'b/.default' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('keeps the client secret out of logs and serialization', () => {
    const credential = new ClientSecretCredential('tenant', 'client', 'super-secret')

    expect(inspect(credential)).not.toContain('super-secret')
    expect(JSON.stringify(credential)).not.toContain('super-secret')
  })
})
