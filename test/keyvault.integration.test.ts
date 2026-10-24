import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { DefaultAzureCredential } from '../src/default-azure-credential'
import { KeyVaultSecretClient } from '../src/keyvault-secrets'
import type { KeyVaultSecret } from '../src/keyvault-secrets'
import { collect, randomToken } from './helpers'

const env = process.env
const keyVaultUrl = env['AZUREFETCH_KEYVAULT_URL']
const purgeDeletedSecrets = env['AZUREFETCH_KEYVAULT_PURGE_TESTS'] === '1'
const configured = [
  keyVaultUrl,
  env['AZURE_TENANT_ID'],
  env['AZURE_CLIENT_ID'],
  env['AZURE_CLIENT_SECRET'],
].every((value) => value !== undefined && value !== '')

/** Deletion, recovery and purge complete asynchronously in Key Vault. */
async function eventually<T>(operation: () => Promise<T>): Promise<T> {
  return await vi.waitFor(operation, { timeout: 90_000, interval: 2000 })
}

function versionOf(secret: KeyVaultSecret): string {
  const { version } = secret.properties
  if (version === undefined) {
    throw new Error('Expected the secret to include a version')
  }

  return version
}

describe.runIf(env['AZUREFETCH_RUN_KEYVAULT_TESTS'] === '1' && configured)(
  'key vault integration (manual)',
  () => {
    const client = new KeyVaultSecretClient(
      keyVaultUrl ?? 'https://unconfigured.vault.azure.net',
      new DefaultAzureCredential(),
    )
    const runToken = randomToken()
    const secretName = `azfetch-secret-${runToken}`
    const initialTags = { suite: 'azfetch', run: runToken, stage: 'initial' }
    let firstVersion: KeyVaultSecret
    let latestVersion: KeyVaultSecret

    beforeAll(async () => {
      firstVersion = await client.setSecret(secretName, 'hello-keyvault', {
        contentType: 'text/plain',
        enabled: true,
        tags: initialTags,
      })
      latestVersion = await client.setSecret(secretName, 'hello-keyvault-v2')
    }, 120_000)

    afterAll(async () => {
      try {
        await client.deleteSecret(secretName)
      } catch {
        // Already deleted or purged by a test.
      }

      if (purgeDeletedSecrets) {
        try {
          await eventually(async () => {
            await client.purgeDeletedSecret(secretName)
          })
        } catch {
          // Purged by the purge test already.
        }
      }
    }, 120_000)

    test('setSecret creates versions and getSecret reads latest and explicit ones', async () => {
      expect(firstVersion).toMatchObject({
        name: secretName,
        value: 'hello-keyvault',
        properties: { contentType: 'text/plain', tags: initialTags },
      })
      expect(versionOf(latestVersion)).not.toBe(versionOf(firstVersion))
      await expect(client.getSecret(secretName)).resolves.toMatchObject({
        value: 'hello-keyvault-v2',
      })
      await expect(
        client.getSecret(secretName, { version: versionOf(firstVersion) }),
      ).resolves.toMatchObject({ value: 'hello-keyvault' })
    })

    test('updateSecretProperties updates metadata of one version', async () => {
      const updatedTags = { ...initialTags, stage: 'updated' }

      await expect(
        client.updateSecretProperties(secretName, versionOf(firstVersion), {
          contentType: 'application/json',
          tags: updatedTags,
        }),
      ).resolves.toMatchObject({
        version: versionOf(firstVersion),
        contentType: 'application/json',
        enabled: true,
        tags: updatedTags,
      })
    })

    test('lists the secret and both versions', async () => {
      const secrets = await collect(client.listPropertiesOfSecrets())
      const versions = await collect(client.listPropertiesOfSecretVersions(secretName))

      expect(secrets.map(({ name }) => name)).toContain(secretName)
      expect(versions.map(({ version }) => version)).toStrictEqual(
        expect.arrayContaining([versionOf(firstVersion), versionOf(latestVersion)]),
      )
    })

    test('deleted secrets can be read, listed and recovered', async () => {
      await expect(client.deleteSecret(secretName)).resolves.toMatchObject({ name: secretName })
      const deletedSecret = await eventually(async () => await client.getDeletedSecret(secretName))
      expect(deletedSecret.deletedOn).toBeInstanceOf(Date)
      const deleted = await collect(client.listDeletedSecrets())
      expect(deleted.map(({ name }) => name)).toContain(secretName)

      await eventually(async () => await client.recoverDeletedSecret(secretName))
      await expect(
        eventually(async () => await client.getSecret(secretName)),
      ).resolves.toMatchObject({ value: 'hello-keyvault-v2' })
    }, 240_000)

    test.runIf(purgeDeletedSecrets)(
      'purgeDeletedSecret permanently removes the deleted secret',
      async () => {
        await client.deleteSecret(secretName)
        await eventually(async () => await client.getDeletedSecret(secretName))
        await eventually(async () => {
          await client.purgeDeletedSecret(secretName)
        })

        await expect(client.getDeletedSecret(secretName)).rejects.toMatchObject({ status: 404 })
      },
      120_000,
    )
  },
)
