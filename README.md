# azurefetch

[![npm version](https://img.shields.io/npm/v/%40itpropro%2Fazurefetch?style=flat&colorA=18181B&colorB=F59E0B)](https://www.npmjs.com/package/@itpropro/azurefetch)
[![bundle size](https://img.shields.io/bundlephobia/minzip/%40itpropro%2Fazurefetch?style=flat&colorA=18181B&colorB=F59E0B)](https://bundlephobia.com/package/@itpropro/azurefetch)

Fetch-first Azure utilities for modern runtimes.

`azurefetch` keeps the Azure surface small, explicit, and easy to use. It focuses on precise implementations that work well in workers, browsers, Bun, Deno, and Node without pulling in a large dependency graph.

## Why azurefetch?

- Zero runtime dependencies
- Fetch-first API that fits modern runtimes
- Worker-compatible and browser-friendly by default
- Easy auth story with explicit credentials or a default credential chain
- Small, focused client surfaces for Blob, Table, Key Vault secrets, and App Configuration keys
- Tree-shakeable ESM exports with a simple root API

## Installation

```bash
# bun
bun add @itpropro/azurefetch

# npm
npm install @itpropro/azurefetch

# pnpm
pnpm add @itpropro/azurefetch
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
} from "@itpropro/azurefetch";
```

`AzureClient` is the main entrypoint for standard request flows. It resolves Azure auth headers and delegates the actual request to `fetch`.

```ts
import { AzureClient } from "@itpropro/azurefetch";

const client = new AzureClient({
  scope: "https://storage.azure.com/.default",
  authorityHost: "https://login.microsoftonline.com",
});

const response = await client.fetch("https://example.blob.core.windows.net/container/hello.txt", {
  method: "GET",
  headers: {
    "x-ms-version": "2024-11-04",
  },
});

console.log(response.status);
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
} from "@itpropro/azurefetch";

const client = new AzureClient({
  scope: "https://storage.azure.com/.default",
});

await uploadText(client, "https://myaccount.blob.core.windows.net/container/hello.txt", "hello");

const textResult = await downloadText(client, "https://myaccount.blob.core.windows.net/container/hello.txt");
console.log(textResult.text);

const config = await downloadJson<{ mode: string }>(
  client,
  "https://myaccount.blob.core.windows.net/container/config.json",
);
console.log(config.value.mode);

const entity = await getEntity(client, "https://myaccount.table.core.windows.net/my-table", "pk", "rk");
console.log(entity.entity?.rowKey);

await upsertEntity(client, "https://myaccount.table.core.windows.net/my-table", {
  partitionKey: "pk",
  rowKey: "rk",
  value: 1,
});

for await (const page of listEntitiesPage(client, "https://myaccount.table.core.windows.net/my-table", {
  maxPageSize: 100,
})) {
  console.log(page.entities.length);
}
```

### App Configuration

Import `AppConfigurationClient` and `DefaultAzureCredential` from the main package:

```ts
import { AppConfigurationClient } from "@itpropro/azurefetch";
import { DefaultAzureCredential } from "@itpropro/azurefetch";

const client = new AppConfigurationClient("https://my-app-config.azconfig.io", new DefaultAzureCredential(), {
  prefix: "my-app",
  label: "production",
});

await client.setConfigurationSetting("api-url", "https://example.com", {
  contentType: "text/plain",
  tags: { service: "frontend" },
});

const setting = await client.getConfigurationSetting("api-url");
console.log(setting.value);

for await (const page of client.listConfigurationSettings().byPage()) {
  console.log(page.value.map((item) => item.key));
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
} from "@itpropro/azurefetch";

const blobService = new BlobServiceClient("https://myaccount.blob.core.windows.net", new DefaultAzureCredential());

const container = blobService.getContainerClient("my-container");
const blobClient = container.getBlockBlobClient("greeting.txt");
await blobClient.upload("hello");

const tableService = new TableServiceClient(
  "https://myaccount.table.core.windows.net",
  new StorageSharedKeyCredential("myaccount", "<storage-key>"),
);

const table = tableService.getTableClient("my-table");
await table.createIfNotExists();

const secretClient = new KeyVaultSecretClient("https://my-vault.vault.azure.net", new DefaultAzureCredential());

const secret = await secretClient.getSecret("my-secret");
console.log(secret.value);
```

## Credentials

`AzureClient` accepts credentials implementing one of:

- `getAuthorizationHeader(scope?)`
- `getToken(scopes)`

If no credential is provided, it falls back to the default token loader from the main package.

### Default credential chain

`getDefaultAzureCredentialToken` tries credentials in this order:

1. environment service principal (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`)
2. managed identity (`/.default` scope)
3. Azure CLI (`az account get-access-token`) when command execution is available
4. Azure PowerShell (`Get-AzAccessToken` via `pwsh` or `powershell`) when command execution is available

```ts
import { getDefaultAzureCredentialToken } from "@itpropro/azurefetch";

const token = await getDefaultAzureCredentialToken({
  scope: "https://management.azure.com/.default",
});

console.log(token.token);
```

Provide an explicit `fetch` implementation if you are running outside globals:

```ts
import { getDefaultAzureCredentialToken } from "@itpropro/azurefetch";

const token = await getDefaultAzureCredentialToken({
  scope: "https://graph.microsoft.com/.default",
  fetch: globalThis.fetch,
  authorityHost: "https://login.microsoftonline.com",
});
```

`globalThis.fetch` is required for managed identity and service principal flows. CLI and PowerShell are only attempted when command execution is available, including Node-compatible runtimes and Deno.

## Public entrypoint

| Entry point            | Purpose                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@itpropro/azurefetch` | Main public API: fetch helpers, Blob, Table, Key Vault, App Configuration, shared credentials, and default Azure credential helpers |

## Manual App Configuration integration test

The App Configuration live test is opt-in and reuses the existing service principal environment variables.

Required:

- `AZUREFETCH_RUN_APP_CONFIGURATION_TESTS=1`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- either `AZUREFETCH_APP_CONFIGURATION_ENDPOINT` or `AZUREFETCH_APP_CONFIGURATION_NAME`

Optional:

- `AZUREFETCH_APP_CONFIGURATION_ENDPOINT_SUFFIX` (defaults to `azconfig.io`)

Using a full endpoint:

```bash
AZUREFETCH_RUN_APP_CONFIGURATION_TESTS=1 \
AZURE_TENANT_ID=<tenant-id> \
AZURE_CLIENT_ID=<client-id> \
AZURE_CLIENT_SECRET=<client-secret> \
AZUREFETCH_APP_CONFIGURATION_ENDPOINT=https://<store>.azconfig.io \
bun run test:app-configuration
```

Using a store name:

```bash
AZUREFETCH_RUN_APP_CONFIGURATION_TESTS=1 \
AZURE_TENANT_ID=<tenant-id> \
AZURE_CLIENT_ID=<client-id> \
AZURE_CLIENT_SECRET=<client-secret> \
AZUREFETCH_APP_CONFIGURATION_NAME=<store> \
bun run test:app-configuration
```

## License

MIT
