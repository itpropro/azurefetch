# azurefetch

[![npm version](https://img.shields.io/npm/v/azurefetch?style=flat&colorA=18181B&colorB=B45309)](https://www.npmjs.com/package/azurefetch)
[![dependencies](https://img.shields.io/badge/dependencies-0-B45309?style=flat&labelColor=18181B)](https://www.npmjs.com/package/azurefetch?activeTab=dependencies)
[![coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fitpropro.github.io%2Fazurefetch%2Fbadge.json&style=flat)](https://itpropro.github.io/azurefetch/)
[![openssf scorecard](https://img.shields.io/ossf-scorecard/github.com/itpropro/azurefetch?label=openssf%20scorecard&style=flat&colorA=18181B&colorB=B45309)](https://scorecard.dev/viewer/?uri=github.com/itpropro/azurefetch)
[![bundle size](https://img.shields.io/bundlephobia/minzip/azurefetch?style=flat&colorA=18181B&colorB=B45309)](https://bundlephobia.com/package/azurefetch)

Fetch-first Azure utilities for modern runtimes.

`azurefetch` is a dependency-free TypeScript library for a focused subset of Azure Storage, Key Vault secrets, and App Configuration. It uses the platform `fetch`, `Request`, `Response`, and Web Crypto APIs, so the same package works in browsers, workers, Bun, Deno, and Node.

## Why azurefetch?

- Zero runtime dependencies
- Fetch-first API that fits modern runtimes
- Worker-compatible and browser-friendly by default
- Easy auth story with explicit credentials or a default credential chain
- Small, focused client surfaces for Blob, Table, Key Vault secrets, and App Configuration keys
- Tree-shakeable ESM exports with a simple root API

## Current status

azurefetch ships one ESM entrypoint targeting ES2022, includes TypeScript declarations, and has no runtime dependencies.

| Area              | Implemented operations                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication    | Service principal, workload identity, managed identity, Azure CLI, Azure PowerShell, token credentials, header credentials                     |
| Blob Storage      | Connection strings; container create, delete, existence, and listing; blob upload, download, properties, and delete; batch delete; account SAS |
| Table Storage     | Connection strings; table create and delete; entity create, get, update, upsert, delete, and queries; etags; EDM types; transactions           |
| Key Vault secrets | Secret set, get, update, delete, recover, and purge; secret, deleted secret, and version listing                                               |
| App Configuration | Key-value get, set, delete, and listing; prefixes, labels, filters, connection strings, and sync tokens                                        |

This is a focused client library, not a drop-in replacement for the full Azure SDK packages.

### Default protocol versions

| Service or protocol           | Version      |
| ----------------------------- | ------------ |
| Azure Blob and Table REST     | `2024-11-04` |
| Azure Tables OData headers    | `3.0;NetFx`  |
| Azure App Configuration       | `2023-11-01` |
| Azure Key Vault               | `7.6`        |
| Managed identity, App Service | `2019-08-01` |
| Managed identity, Cloud Shell | `2017-09-01` |
| Managed identity, IMDS        | `2018-02-01` |

App Configuration accepts an `apiVersion` override. The other values are the defaults used by the current implementation.

## Installation

```bash
# bun
bun add azurefetch

# npm
npm install azurefetch

# pnpm
pnpm add azurefetch
```

## Usage

### Core fetch client

Import the generic fetch helpers from the root entrypoint:

```ts
import {
  AzureClient,
  downloadJson,
  downloadText,
  getEntity,
  listEntitiesPage,
  uploadText,
  upsertEntity,
} from 'azurefetch'
```

`AzureClient` is the main entrypoint for standard request flows. It resolves Azure auth headers and delegates the actual request to `fetch`.

```ts
import { AzureClient } from 'azurefetch'

const client = new AzureClient({
  scope: 'https://storage.azure.com/.default',
  authorityHost: 'https://login.microsoftonline.com',
})

const response = await client.fetch('https://example.blob.core.windows.net/container/hello.txt', {
  method: 'GET',
  headers: {
    'x-ms-version': '2024-11-04',
  },
})

console.log(response.status)
```

### Convenience helpers

Use the tiny helpers for common blob and table operations:

```ts
import {
  AzureClient,
  downloadJson,
  downloadText,
  getEntity,
  listEntitiesPage,
  upsertEntity,
  uploadText,
} from 'azurefetch'

const client = new AzureClient({
  scope: 'https://storage.azure.com/.default',
})

await uploadText(client, 'https://myaccount.blob.core.windows.net/container/hello.txt', 'hello')

const textResult = await downloadText(
  client,
  'https://myaccount.blob.core.windows.net/container/hello.txt',
)
console.log(textResult.text)

const config = await downloadJson(
  client,
  'https://myaccount.blob.core.windows.net/container/config.json',
  (value) => value as { mode: string },
)
console.log(config.value.mode)

const entity = await getEntity(
  client,
  'https://myaccount.table.core.windows.net/my-table',
  'pk',
  'rk',
)
console.log(entity.entity?.rowKey)

await upsertEntity(client, 'https://myaccount.table.core.windows.net/my-table', {
  partitionKey: 'pk',
  rowKey: 'rk',
  value: 1,
})

for await (const page of listEntitiesPage(
  client,
  'https://myaccount.table.core.windows.net/my-table',
  {
    maxPageSize: 100,
  },
)) {
  console.log(page.entities.length)
}
```

### App Configuration

Import `AppConfigurationClient` and `DefaultAzureCredential` from the main package:

```ts
import { AppConfigurationClient } from 'azurefetch'
import { DefaultAzureCredential } from 'azurefetch'

const client = new AppConfigurationClient(
  'https://my-app-config.azconfig.io',
  new DefaultAzureCredential(),
  {
    prefix: 'my-app',
    label: 'production',
  },
)

await client.setConfigurationSetting('api-url', 'https://example.com', {
  contentType: 'text/plain',
  tags: { service: 'frontend' },
})

const setting = await client.getConfigurationSetting('api-url')
console.log(setting.value)

for await (const page of client.listConfigurationSettings().byPage()) {
  console.log(page.value.map((item) => item.key))
}
```

### Blob, Table, and Key Vault clients

Import service clients from the main package:

```ts
import {
  BlobServiceClient,
  DefaultAzureCredential,
  KeyVaultSecretClient,
  StorageSharedKeyCredential,
  TableServiceClient,
} from 'azurefetch'

const blobService = new BlobServiceClient(
  'https://myaccount.blob.core.windows.net',
  new DefaultAzureCredential(),
)

const container = blobService.getContainerClient('my-container')
const blobClient = container.getBlockBlobClient('greeting.txt')
await blobClient.upload('hello')

const tableService = new TableServiceClient(
  'https://myaccount.table.core.windows.net',
  new StorageSharedKeyCredential('myaccount', '<storage-key>'),
)

const table = tableService.getTableClient('my-table')
await table.createIfNotExists()

const secretClient = new KeyVaultSecretClient(
  'https://my-vault.vault.azure.net',
  new DefaultAzureCredential(),
)

const secret = await secretClient.getSecret('my-secret')
console.log(secret.value)
```

Account SAS generation requires a shared-key credential and is asynchronous because signing uses Web Crypto:

```ts
const sharedKey = new StorageSharedKeyCredential('myaccount', '<storage-key>')
const blobServiceWithSharedKey = new BlobServiceClient(
  'https://myaccount.blob.core.windows.net',
  sharedKey,
)
const accountSasUrl = await blobServiceWithSharedKey.generateAccountSasUrl(
  new Date(Date.now() + 60 * 60 * 1000),
  {
    permissions: 'rl',
  },
)
```

Table reads return the entity's `etag` and its `timestamp` string. `Date`, `bigint` and `Uint8Array` values are written as `Edm.DateTime`, `Edm.Int64` and `Edm.Binary`; any EDM type can also be set explicitly as `{ value, type }`. Reads decode those three types back and return Guids as `{ value, type: 'Guid' }`. Writes return the new `etag`. `updateEntity` and `deleteEntity` send an etag as `If-Match` and fail with 412 when it is stale; without one they match any version. `upsertEntity` and transaction upserts replace by default and merge with `'Merge'`.

```ts
import { odata } from 'azurefetch'

const { etag } = await table.createEntity({
  partitionKey: 'pk',
  rowKey: 'rk',
  createdOn: new Date(),
  size: 1n,
})
await table.updateEntity({ partitionKey: 'pk', rowKey: 'rk', size: 2n }, 'Merge', { etag })

const query = { filter: odata`PartitionKey eq ${'pk'}`, select: ['rowKey', 'size'] }
for await (const page of table.listEntities(query).byPage()) {
  console.log(page.value)
}
```

## Credentials

`AzureClient` accepts credentials implementing one of:

- `getAuthorizationHeader(scope?)`
- `getToken(scopes, options?)`, the `TokenCredential` shape of `@azure/core-auth`

If no credential is provided, it uses a `DefaultAzureCredential` for the configured authority host.

`DefaultAzureCredential` and `ClientSecretCredential` are `TokenCredential`s, so Azure SDK clients can use them. Their `getToken` honors these options:

- `abortSignal` cancels only that caller; a shared token request stops once every caller has aborted.
- `tenantId` requests a token from another tenant if it is the configured tenant or listed in `additionallyAllowedTenants` (`*` allows any). Set `AZURE_IDENTITY_DISABLE_MULTITENANTAUTH` to ignore it.
- `claims` answers a claims challenge with a new token. Azure CLI and Azure PowerShell can't, so their error contains the `az login` and `Connect-AzAccount` command to run.
- `enableCae` requests a token for continuous access evaluation.

Tokens are cached per scope, tenant and CAE setting. When a refresh fails, the cached token is used until it expires, and the next refresh waits 30 s.

Custom authority hosts, Key Vault URLs, and App Configuration endpoints must use HTTPS.

### Default credential chain

`getDefaultAzureCredentialToken` tries credentials in this order:

1. environment credential with `AZURE_TENANT_ID` and `AZURE_CLIENT_ID`, using the first of:
   - a client secret in `AZURE_CLIENT_SECRET`
   - a PEM certificate with its private key in `AZURE_CLIENT_CERTIFICATE_PATH`. `AZURE_CLIENT_CERTIFICATE_PASSWORD` decrypts the key on Node, Bun and Deno; `AZURE_CLIENT_SEND_CERTIFICATE_CHAIN=true` sends the chain for subject name and issuer authentication.
   - a username and password in `AZURE_USERNAME` and `AZURE_PASSWORD`, which fails for accounts that require MFA

   Its failures stop the chain. `AZURE_ADDITIONALLY_ALLOWED_TENANTS` lists further tenants, separated by semicolons, unless `additionallyAllowedTenants` is set.

2. AKS workload identity (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_FEDERATED_TOKEN_FILE`); its failures stop the chain, except a refused per-call tenant
3. managed identity (`/.default` scope), using `managedIdentityClientId` or else `AZURE_CLIENT_ID`
4. Azure CLI (`az account get-access-token`) when command execution is available
5. Azure PowerShell (`Get-AzAccessToken` via `pwsh` or `powershell`) when command execution is available

The `tenantId` option selects the tenant for workload identity, Azure CLI and Azure PowerShell. For an explicit service principal, use `new ClientSecretCredential(tenantId, clientId, clientSecret)`.

```ts
import { getDefaultAzureCredentialToken } from 'azurefetch'

const token = await getDefaultAzureCredentialToken({
  scope: 'https://management.azure.com/.default',
})

console.log(token.token)
```

Provide an explicit `fetch` implementation if you are running outside globals:

```ts
import { getDefaultAzureCredentialToken } from 'azurefetch'

const token = await getDefaultAzureCredentialToken({
  scope: 'https://graph.microsoft.com/.default',
  fetch: globalThis.fetch,
  authorityHost: 'https://login.microsoftonline.com',
})
```

`globalThis.fetch` is required for managed identity and service principal flows. CLI and PowerShell are only attempted where `node:child_process` is available: Node, Bun, and Deno 2.

### Retries

Token and service requests retry network errors and 408, 429, 500, 502, 503 and 504 responses up to 3 times. The wait doubles from 1 s up to 60 s, or follows the service's `retry-after-ms`, `x-ms-retry-after-ms` or `Retry-After` header; a hint above the maximum wait returns the response without retrying. Managed identity on IMDS retries 5 times from 800 ms and also retries 404 and 410. Azure CLI and Azure PowerShell don't retry, and stream bodies are sent once.

Credentials, `AzureClient` and the service clients accept `retryOptions`, and an `AzureClient` request can override them:

```ts
import { AzureClient } from 'azurefetch'

const client = new AzureClient({ retryOptions: { maxRetries: 5, maxRetryDelayInMs: 30_000 } })
const response = await client.fetch('https://myaccount.blob.core.windows.net/container/blob', {
  azure: { retryOptions: { maxRetries: 0 } },
})
```

`retryOptions` also takes `retryDelayInMs`, `retryableStatuses`, and `shouldRetry(context)` and `retryDelay(context)` hooks that return `undefined` to keep the default.

### Developer credential flow

`getDeveloperAzureCredentialToken` is a narrower alternative that only tries Azure CLI, then Azure PowerShell when CLI credentials are unavailable. It does not read service-principal environment variables or probe managed identity.

```ts
import { getDeveloperAzureCredentialToken } from 'azurefetch'

const controller = new AbortController()
const token = await getDeveloperAzureCredentialToken({
  scope: 'https://management.azure.com/.default',
  abortSignal: controller.signal,
})
```

Malformed CLI output and cancellation are terminal. Azure PowerShell is not attempted in either case.

## Public entrypoint

| Entry point  | Purpose                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `azurefetch` | Main public API: fetch helpers, Blob, Table, Key Vault, App Configuration, shared credentials, and default Azure credential helpers |

## License

MIT
