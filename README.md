# azurefetch

[![npm version](https://img.shields.io/npm/v/%40itpropro%2Fazurefetch?style=flat&colorA=18181B&colorB=F59E0B)](https://www.npmjs.com/package/azurefetch)
[![bundle size](https://img.shields.io/bundlephobia/minzip/%40itpropro%2Fazurefetch?style=flat&colorA=18181B&colorB=F59E0B)](https://bundlephobia.com/package/azurefetch)

Fetch-first Azure utilities for modern runtimes.

`azurefetch` is a no dependency fetch focused library to interact with azure resources, mainly storage and config related resources like key vault and app config. It focuses on an implementation that works well in workers, browsers, Bun, Deno, and Node without pulling in a large dependency graph and makes interacting with basic Azure resources easier.

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
} from "azurefetch";
```

`AzureClient` is the main entrypoint for standard request flows. It resolves Azure auth headers and delegates the actual request to `fetch`.

```ts
import { AzureClient } from "azurefetch";

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
} from "azurefetch";

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
import { AppConfigurationClient } from "azurefetch";
import { DefaultAzureCredential } from "azurefetch";

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
} from "azurefetch";

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

Account SAS generation requires a shared-key credential and is asynchronous because signing uses Web Crypto:

```ts
const sharedKey = new StorageSharedKeyCredential("myaccount", "<storage-key>");
const blobServiceWithSharedKey = new BlobServiceClient("https://myaccount.blob.core.windows.net", sharedKey);
const accountSasUrl = await blobServiceWithSharedKey.generateAccountSasUrl(new Date(Date.now() + 60 * 60 * 1000), {
  permissions: "rl",
});
```

## Credentials

`AzureClient` accepts credentials implementing one of:

- `getAuthorizationHeader(scope?)`
- `getToken(scopes)`

If no credential is provided, it falls back to the default token loader from the main package.

Custom authority hosts, Key Vault URLs, and App Configuration endpoints must use HTTPS.

### Default credential chain

`getDefaultAzureCredentialToken` tries credentials in this order:

1. environment service principal (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`)
2. managed identity (`/.default` scope)
3. Azure CLI (`az account get-access-token`) when command execution is available
4. Azure PowerShell (`Get-AzAccessToken` via `pwsh` or `powershell`) when command execution is available

```ts
import { getDefaultAzureCredentialToken } from "azurefetch";

const token = await getDefaultAzureCredentialToken({
  scope: "https://management.azure.com/.default",
});

console.log(token.token);
```

Provide an explicit `fetch` implementation if you are running outside globals:

```ts
import { getDefaultAzureCredentialToken } from "azurefetch";

const token = await getDefaultAzureCredentialToken({
  scope: "https://graph.microsoft.com/.default",
  fetch: globalThis.fetch,
  authorityHost: "https://login.microsoftonline.com",
});
```

`globalThis.fetch` is required for managed identity and service principal flows. CLI and PowerShell are only attempted when command execution is available, including Node-compatible runtimes and Deno.

## Public entrypoint

| Entry point  | Purpose                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `azurefetch` | Main public API: fetch helpers, Blob, Table, Key Vault, App Configuration, shared credentials, and default Azure credential helpers |

## License

MIT
