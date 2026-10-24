import { describe, expect, test, vi } from 'vitest'

import { KeyVaultSecretClient } from '../src/keyvault-secrets'
import { collect, createFetchMock, getBodyString, jsonResponse, textResponse } from './helpers'

const vaultUrl = 'https://example.vault.azure.net'
const secretId = `${vaultUrl}/secrets/app-secret/version-1`

function createClient(fetcher: typeof fetch): KeyVaultSecretClient {
  return new KeyVaultSecretClient(
    vaultUrl,
    { getAuthorizationHeader: async (scope?: string | string[]) => `Bearer ${String(scope)}` },
    { fetch: fetcher },
  )
}

describe('KeyVaultSecretClient', () => {
  test('rejects HTTP vault URLs during construction', () => {
    expect(() => new KeyVaultSecretClient('http://example.vault.azure.net')).toThrow(
      'vaultUrl must use HTTPS',
    )
  })

  test('setSecret sends the Key Vault scope and serializes secret attributes', async () => {
    const expiresOn = new Date('2027-01-01T00:00:00.000Z')
    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe(`${vaultUrl}/secrets/app-secret?api-version=7.6`)
        expect(init.method).toBe('PUT')
        expect(new Headers(init.headers).get('Authorization')).toBe(
          'Bearer https://vault.azure.net/.default',
        )
        expect(JSON.parse(getBodyString(init.body))).toStrictEqual({
          value: 'secret-value',
          contentType: 'text/plain',
          tags: { team: 'platform' },
          attributes: { enabled: true, exp: 1_798_761_600 },
        })
        return jsonResponse({
          id: secretId,
          value: 'secret-value',
          contentType: 'text/plain',
          tags: { team: 'platform' },
          attributes: { enabled: true, exp: 1_798_761_600 },
        })
      },
    ])

    const secret = await createClient(fetcher).setSecret('app-secret', 'secret-value', {
      contentType: 'text/plain',
      enabled: true,
      expiresOn,
      tags: { team: 'platform' },
    })

    expect(secret).toMatchObject({
      name: 'app-secret',
      value: 'secret-value',
      properties: {
        vaultUrl,
        version: 'version-1',
        contentType: 'text/plain',
        enabled: true,
        expiresOn,
        tags: { team: 'platform' },
      },
    })
  })

  test('getSecret requests an explicit version', async () => {
    const fetcher = createFetchMock([
      (url) => {
        expect(url).toBe(`${secretId}?api-version=7.6`)
        return jsonResponse({ id: secretId, value: 'first-version', attributes: {} })
      },
    ])

    await expect(
      createClient(fetcher).getSecret('app-secret', { version: 'version-1' }),
    ).resolves.toMatchObject({ value: 'first-version', properties: { version: 'version-1' } })
  })

  test('updateSecretProperties sends metadata without a value', async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe(`${vaultUrl}/secrets/app-secret/?api-version=7.6`)
        expect(init.method).toBe('PATCH')
        expect(JSON.parse(getBodyString(init.body))).toStrictEqual({
          contentType: 'application/json',
          attributes: { enabled: false },
        })
        return jsonResponse({ id: secretId, contentType: 'application/json', attributes: {} })
      },
    ])

    await expect(
      createClient(fetcher).updateSecretProperties('app-secret', '', {
        contentType: 'application/json',
        enabled: false,
      }),
    ).resolves.toMatchObject({ name: 'app-secret', contentType: 'application/json' })
  })

  test.each([
    {
      operation: 'deleteSecret',
      call: async (client: KeyVaultSecretClient) => await client.deleteSecret('app-secret'),
      method: 'DELETE',
      path: '/secrets/app-secret',
    },
    {
      operation: 'getDeletedSecret',
      call: async (client: KeyVaultSecretClient) => await client.getDeletedSecret('app-secret'),
      method: 'GET',
      path: '/deletedsecrets/app-secret',
    },
    {
      operation: 'recoverDeletedSecret',
      call: async (client: KeyVaultSecretClient) => await client.recoverDeletedSecret('app-secret'),
      method: 'POST',
      path: '/deletedsecrets/app-secret/recover',
    },
  ])('$operation sends $method to $path', async ({ call, method, path }) => {
    const fetcher = createFetchMock([
      (url, init) => {
        expect(init.method).toBe(method)
        expect(new URL(url).pathname).toBe(path)
        return jsonResponse({ id: secretId, attributes: {} })
      },
    ])

    await expect(call(createClient(fetcher))).resolves.toMatchObject({ name: 'app-secret' })
  })

  test('purgeDeletedSecret deletes the deleted secret', async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        expect(init.method).toBe('DELETE')
        expect(new URL(url).pathname).toBe('/deletedsecrets/app-secret')
        return textResponse('', 204)
      },
    ])

    await expect(createClient(fetcher).purgeDeletedSecret('app-secret')).resolves.toBeUndefined()
  })

  test('parses deletion metadata from epoch seconds', async () => {
    const fetcher = createFetchMock([
      () =>
        jsonResponse({
          id: `${vaultUrl}/deletedsecrets/app-secret`,
          recoveryId: `${vaultUrl}/deletedsecrets/app-secret`,
          deletedDate: 1_700_000_000,
          scheduledPurgeDate: 1_700_086_400,
          attributes: { recoveryLevel: 'Recoverable+Purgeable', recoverableDays: 7 },
        }),
    ])

    const deleted = await createClient(fetcher).getDeletedSecret('app-secret')

    const deletion = {
      recoveryId: `${vaultUrl}/deletedsecrets/app-secret`,
      deletedOn: new Date('2023-11-14T22:13:20.000Z'),
      scheduledPurgeDate: new Date('2023-11-15T22:13:20.000Z'),
    }
    expect(deleted).toMatchObject({
      ...deletion,
      properties: { ...deletion, recoveryLevel: 'Recoverable+Purgeable', recoverableDays: 7 },
    })
  })

  test('reports service errors with status and error code', async () => {
    const fetcher = createFetchMock([
      () =>
        jsonResponse(
          { error: { code: 'SecretNotFound', message: 'Missing secret' } },
          404,
          'Not Found',
        ),
    ])

    const request = createClient(fetcher).getSecret('missing')

    await expect(request).rejects.toThrow('Missing secret')
    await expect(request).rejects.toMatchObject({
      name: 'AzureRequestError',
      status: 404,
      errorCode: 'SecretNotFound',
    })
  })

  test('iterates secrets across relative continuation links', async () => {
    const fetcher = createFetchMock([
      (url) => {
        expect(url).toBe(`${vaultUrl}/secrets?api-version=7.6`)
        return jsonResponse({
          value: [{ id: `${vaultUrl}/secrets/first`, attributes: {} }],
          nextLink: '/secrets?api-version=7.6&$skiptoken=page-2',
        })
      },
      (url) => {
        expect(url).toBe(`${vaultUrl}/secrets?api-version=7.6&$skiptoken=page-2`)
        return jsonResponse({ value: [{ id: `${vaultUrl}/secrets/second`, attributes: {} }] })
      },
    ])

    const secrets = await collect(createClient(fetcher).listPropertiesOfSecrets())

    expect(secrets.map(({ name }) => name)).toStrictEqual(['first', 'second'])
  })

  test('starts listing from an explicit continuation link', async () => {
    const fetcher = createFetchMock([
      (url) => {
        expect(url).toBe(`${vaultUrl}/deletedsecrets?api-version=7.6&$skiptoken=next`)
        return jsonResponse({
          value: [{ id: `${vaultUrl}/deletedsecrets/gone`, deletedDate: 1_700_000_000 }],
        })
      },
    ])

    const pages = await collect(
      createClient(fetcher)
        .listDeletedSecrets()
        .byPage({
          continuationToken: `${vaultUrl}/deletedsecrets?api-version=7.6&$skiptoken=next`,
        }),
    )

    expect(pages).toMatchObject([
      { value: [{ name: 'gone', deletedOn: new Date('2023-11-14T22:13:20.000Z') }] },
    ])
  })

  test('rejects continuation links to another origin before sending a request', async () => {
    const fetcher = vi.fn<typeof fetch>()

    await expect(
      collect(
        createClient(fetcher)
          .listPropertiesOfSecretVersions('app-secret')
          .byPage({ continuationToken: 'https://attacker.example/secrets/app-secret/versions' }),
      ),
    ).rejects.toThrow('configured vault origin')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
