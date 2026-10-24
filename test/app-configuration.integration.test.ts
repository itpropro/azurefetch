import { afterAll, describe, expect, test } from 'vitest'

import { AppConfigurationClient } from '../src/app-configuration'
import { DefaultAzureCredential } from '../src/default-azure-credential'
import { collect, randomToken } from './helpers'

const env = process.env
const storeName = env['AZUREFETCH_APP_CONFIGURATION_NAME']
const endpointSuffix = env['AZUREFETCH_APP_CONFIGURATION_ENDPOINT_SUFFIX'] ?? 'azconfig.io'
const endpoint =
  env['AZUREFETCH_APP_CONFIGURATION_ENDPOINT'] ??
  (storeName === undefined ? undefined : `https://${storeName}.${endpointSuffix}`)
const configured = [
  endpoint,
  env['AZURE_TENANT_ID'],
  env['AZURE_CLIENT_ID'],
  env['AZURE_CLIENT_SECRET'],
].every((value) => value !== undefined && value !== '')

describe.runIf(env['AZUREFETCH_RUN_APP_CONFIGURATION_TESTS'] === '1' && configured)(
  'app configuration integration (manual)',
  () => {
    const runToken = randomToken()
    const label = `run-${runToken}`
    const overrideLabel = `${label}-override`
    const client = new AppConfigurationClient(
      endpoint ?? 'https://unconfigured.azconfig.io',
      new DefaultAzureCredential(),
      { prefix: `TestApp:Service1:${runToken}`, label },
    )
    const firstKey = 'ApiEndpoint'
    const secondKey = String.raw`Titles/Welcome, Draft*\日本語`
    const secondValue = 'Line 1\nGrüße 🚀'
    const tags = { suite: 'azfetch', run: runToken }

    afterAll(async () => {
      await Promise.allSettled([
        client.deleteConfigurationSetting(firstKey),
        client.deleteConfigurationSetting(secondKey),
        client.deleteConfigurationSetting(firstKey, { label: overrideLabel }),
      ])
    }, 120_000)

    test('setConfigurationSetting creates keys with prefix, label and unicode content', async () => {
      await expect(
        client.setConfigurationSetting(firstKey, 'hello-appconfig', {
          contentType: 'text/plain',
          tags,
        }),
      ).resolves.toMatchObject({
        key: firstKey,
        label,
        value: 'hello-appconfig',
        contentType: 'text/plain',
        tags,
      })
      await expect(client.setConfigurationSetting(secondKey, secondValue)).resolves.toMatchObject({
        key: secondKey,
        value: secondValue,
      })
      await expect(
        client.setConfigurationSetting(firstKey, 'hello-override', { label: overrideLabel }),
      ).resolves.toMatchObject({ label: overrideLabel })
    }, 120_000)

    test('getConfigurationSetting reads the default and an explicit label', async () => {
      await expect(client.getConfigurationSetting(firstKey)).resolves.toMatchObject({
        value: 'hello-appconfig',
        tags,
      })
      await expect(client.getConfigurationSetting(secondKey)).resolves.toMatchObject({
        value: secondValue,
      })
      await expect(
        client.getConfigurationSetting(firstKey, { label: overrideLabel }),
      ).resolves.toMatchObject({ value: 'hello-override' })
    }, 120_000)

    test('listConfigurationSettings scopes by prefix and default label', async () => {
      const settings = await collect(client.listConfigurationSettings())

      const keys = settings.map(({ key }) => key)
      expect(keys).toHaveLength(2)
      expect(keys).toStrictEqual(expect.arrayContaining([firstKey, secondKey]))
    }, 120_000)

    test('deleteConfigurationSetting removes only the matching label', async () => {
      await expect(client.deleteConfigurationSetting(firstKey)).resolves.toMatchObject({
        key: firstKey,
      })
      await expect(client.getConfigurationSetting(firstKey)).rejects.toMatchObject({ status: 404 })
      await expect(
        client.getConfigurationSetting(firstKey, { label: overrideLabel }),
      ).resolves.toMatchObject({ value: 'hello-override' })
    }, 120_000)
  },
)
