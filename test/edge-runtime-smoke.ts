import { readFile } from 'node:fs/promises'

import type * as Azurefetch from '../src/index'

const rootBundleUrl = new URL('../dist/index.mjs', import.meta.url)

const bundle = await readFile(rootBundleUrl, 'utf8')
for (const snippet of [
  'from "node:',
  "from 'node:",
  'import("node:',
  "import('node:",
  'child_process',
]) {
  if (bundle.includes(snippet)) {
    throw new Error(`Root bundle must stay edge-safe, found ${snippet} in dist/index.mjs`)
  }
}

const runtime: { process?: unknown; Buffer?: unknown } = globalThis
const { process: originalProcess, Buffer: originalBuffer } = runtime
runtime.process = undefined
runtime.Buffer = undefined
try {
  await exerciseServiceClients()
} finally {
  runtime.process = originalProcess
  runtime.Buffer = originalBuffer
}

/** Sends one request through every client while Node globals are hidden. */
async function exerciseServiceClients(): Promise<void> {
  const rootModule: unknown = await import(rootBundleUrl.href)
  if (!isRootModule(rootModule)) {
    throw new Error('Expected the service clients to remain available from the root bundle')
  }

  const {
    AppConfigurationClient,
    BlobServiceClient,
    KeyVaultSecretClient,
    StorageSharedKeyCredential,
    TableServiceClient,
  } = rootModule
  const credential = { getAuthorizationHeader: async () => 'Bearer edge-token' }
  const authorizations: (string | null)[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    authorizations.push(request.headers.get('Authorization'))
    return Response.json(
      {
        id: 'https://example.vault.azure.net/secrets/edge/1',
        key: 'edge',
        value: 'edge-value',
        attributes: {},
      },
      { status: request.method === 'GET' ? 200 : 201 },
    )
  }

  const blobUrl = 'https://myaccount.blob.core.windows.net'
  const tableUrl = 'https://myaccount.table.core.windows.net'
  const sharedKey = new StorageSharedKeyCredential('myaccount', btoa('edge-key'))
  await new BlobServiceClient(blobUrl, credential, { fetch })
    .getContainerClient('edge')
    .createIfNotExists()
  await new TableServiceClient(tableUrl, credential, { fetch }).createTableIfNotExists('edge')
  await new TableServiceClient(tableUrl, sharedKey, { fetch }).createTableIfNotExists('edge')
  const secret = await new KeyVaultSecretClient('https://example.vault.azure.net', credential, {
    fetch,
  }).getSecret('edge')
  const setting = await new AppConfigurationClient('https://example.azconfig.io', credential, {
    fetch,
  }).getConfigurationSetting('edge')

  if (secret.value !== 'edge-value' || setting.value !== 'edge-value') {
    throw new Error('Expected Key Vault and App Configuration values to round-trip')
  }

  if (authorizations.length !== 5 || authorizations.includes(null)) {
    throw new Error(`Expected 5 authorized requests, received ${JSON.stringify(authorizations)}`)
  }
}

function isRootModule(value: unknown): value is typeof Azurefetch {
  return (
    typeof value === 'object' &&
    value !== null &&
    [
      'AzureClient',
      'AppConfigurationClient',
      'BlobServiceClient',
      'DefaultAzureCredential',
      'KeyVaultSecretClient',
      'StorageSharedKeyCredential',
      'TableServiceClient',
      'getDefaultAzureCredentialToken',
    ].every((name) => name in value)
  )
}
