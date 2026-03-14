# azurefetch

Minimal, dependency-free Azure fetch utilities for modern runtimes.

## Usage

Import helpers from the package entrypoint:

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
import { getAuthorizationHeader, getDefaultAzureCredentialToken, getServicePrincipalToken } from "azurefetch";
```

### Azure fetch-first client

`AzureClient` is the preferred entrypoint for standard request flows. It signs requests with AAD token headers and delegates to `fetch`.

```ts
import { AzureClient } from "azurefetch";

const client = new AzureClient({
  scope: "https://storage.azure.com/.default",
  authorityHost: "https://login.microsoftonline.com",
});

const request = await client.sign("https://example.blob.core.windows.net/container/hello.txt", {
  method: "GET",
  headers: {
    "x-ms-version": "2024-11-04",
  },
  azure: {
    // optional per-request overrides:
    // scope: "https://graph.microsoft.com/.default",
    // credential: anotherCredential,
    // authorityHost: "https://login.partner.microsoftonline.com",
  },
});

const response = await client.fetch("https://example.blob.core.windows.net/container/hello.txt", {
  method: "GET",
  azure: {
    scope: "https://storage.azure.com/.default",
  },
});

console.log(response.status);
```

### Convenience helpers

Use these tiny helpers for common blob/table operations:

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
  if (page.continuationToken != null) {
    console.log(page.continuationToken);
  }
}
```

`AzureClient` accepts credentials implementing one of:

- `getAuthorizationHeader(scope?)`
- `getToken(scopes)`

If no credential is passed, it falls back to `getDefaultAzureCredentialToken()`.

### Default credential chain

`getDefaultAzureCredentialToken` tries credentials in this order:

1. environment service principal (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`)
2. managed identity (`/.default` scope)
3. Azure CLI (`az account get-access-token`)
4. Azure PowerShell (`Get-AzAccessToken` via `pwsh` or `powershell`)

Example:

```ts
import { getDefaultAzureCredentialToken } from "azurefetch";

const token = await getDefaultAzureCredentialToken({
  scope: "https://management.azure.com/.default",
});

console.log(token.token);
```

### Compatibility APIs

For compatibility, this package also exposes a small subset of Azure Storage APIs:

```ts
import {
  BlobServiceClient,
  DefaultAzureCredential,
  StorageSharedKeyCredential,
  AccountSASPermissions,
  getAccountNameFromUrl,
  TableServiceClient,
  TableClient,
} from "azurefetch";

const service = new BlobServiceClient("https://myaccount.blob.core.windows.net", new DefaultAzureCredential());

const container = service.getContainerClient("my-container");
// BlockBlobClient is created via `getBlockBlobClient` and is not a top-level export.
const blobClient = container.getBlockBlobClient("greeting.txt");

await blobClient.upload("hello");
const response = await blobClient.download(0, 5);
const text = await response.text();

const tableService = new TableServiceClient(
  "https://myaccount.table.core.windows.net",
  new StorageSharedKeyCredential("myaccount", "<storage-key>"),
);

const table = tableService.getTableClient("my-table");
await table.createIfNotExists();
const entity = await table.getEntity("pk", "rk");

const tableClient = new TableClient(
  "https://myaccount.table.core.windows.net/my-table",
  "my-table",
  new StorageSharedKeyCredential("myaccount", "<storage-key>"),
  globalThis.fetch,
  "https://myaccount.table.core.windows.net",
);
await tableClient.upsertEntity({ partitionKey: "pk", rowKey: "rk", value: "v" }, "Replace");
for await (const page of tableClient.list().byPage({ maxPageSize: 100 })) {
  console.log(page.value);
}
```

Supported API surface:

| Client                       | Methods                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `AzureClient`                | `fetch`, `sign`                                                                                          |
| `Convenience helpers`        | `uploadText`, `downloadText`, `downloadJson`, `getEntity`, `upsertEntity`, `listEntitiesPage`            |
| `DefaultAzureCredential`     | `getToken`, `getAuthorizationHeader`                                                                     |
| `StorageSharedKeyCredential` | constructor, `computeHMACSHA256`                                                                         |
| `AccountSASPermissions`      | `parse`, `toString`                                                                                      |
| `BlobServiceClient`          | `fromConnectionString`, `getContainerClient`, `generateAccountSasUrl`, `listContainers().byPage(...)`    |
| `ContainerClient`            | `createIfNotExists`, `deleteIfExists`, `exists`, `listBlobsFlat().byPage(...)`, `getBlockBlobClient`     |
| `TableServiceClient`         | `fromConnectionString`, `getTableClient`, `createTableIfNotExists`, `deleteTableIfExists`                |
| `TableClient`                | `createIfNotExists`, `deleteIfExists`, `getEntity`, `upsertEntity`, `deleteEntity`, `list().byPage(...)` |
| Utilities                    | `getAccountNameFromUrl`                                                                                  |

Provide an explicit `fetch` function if you are running outside globals:

```ts
import { getDefaultAzureCredentialToken } from "azurefetch";

const token = await getDefaultAzureCredentialToken({
  scope: "https://graph.microsoft.com/.default",
  fetch: globalThis.fetch,
  authorityHost: "https://login.microsoftonline.com",
});
```

`globalThis.fetch` is required for managed identity and service principal flows; CLI/PowerShell are only attempted when command execution is available.

## Manual storage integration tests

Backend integration coverage is manual to avoid hitting live infrastructure in default test runs. Set
`AZUREFETCH_RUN_STORAGE_TESTS=1` and either:

- Shared-key mode:
  - `AZUREFETCH_STORAGE_CONNECTION_STRING`

- Service-principal mode:
  - `AZUREFETCH_STORAGE_ACCOUNT_NAME`
  - `AZURE_TENANT_ID`
  - `AZURE_CLIENT_ID`
  - `AZURE_CLIENT_SECRET`

Optional overrides:

- `AZUREFETCH_STORAGE_ENDPOINT_SUFFIX` (defaults to `core.windows.net`)
- `AZUREFETCH_STORAGE_BLOB_ENDPOINT` / `AZUREFETCH_STORAGE_TABLE_ENDPOINT`
- `AZUREFETCH_STORAGE_AUTH_MODE=service-principal` (to force AAD mode when both shared-key and SP are configured)
- `AZUREFETCH_STORAGE_AUTH_MODE=connection-string` (to force shared-key mode)

```bash
AZUREFETCH_RUN_STORAGE_TESTS=1 \
AZUREFETCH_STORAGE_ACCOUNT_NAME=<storage-account-name> \
AZURE_TENANT_ID=<tenant-id> \
AZURE_CLIENT_ID=<client-id> \
AZURE_CLIENT_SECRET=<client-secret> \
bun run test:storage
```

Shared-key mode example:

```bash
AZUREFETCH_RUN_STORAGE_TESTS=1 \
AZUREFETCH_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=..." \
bun run test:storage
```

To run against Azurite:

```bash
bun run test:storage:azurite
```

Live service-principal runs can be slower than local Azurite runs due network latency.

The integration suite validates create/list/read/write/delete for blobs and tables, and removes all created resources in cleanup.

## Standalone storage benchmark

The repository includes an opt-in benchmark that runs real Azure Storage operations for blob/table workflows. By default it performs 5 iterations plus 1 warmup run:

- create container, upload, download, list containers, list blobs, delete blob/container
- create table, upsert entity, get entity, list entities, delete entity/table
- warmup iterations (excluded from summary)
- compares two drivers by default: library-native storage client surface and Azure SDK
- blob batch delete benchmark (runs with the same warmup/iteration settings), defaulting to 50 blobs and configurable with `AZUREFETCH_BENCHMARK_BATCH_SIZE`
- percentile summaries when run with `--detailed` or `AZUREFETCH_BENCHMARK_DETAILED=1`

Driver selection can be controlled with:

- `AZUREFETCH_BENCHMARK_DRIVER=native` (library-native implementation only)
- `AZUREFETCH_BENCHMARK_DRIVER=sdk` (SDK-only implementation)
- `AZUREFETCH_BENCHMARK_DRIVER=both` (default, run both for side-by-side output)

Enable it with `AZUREFETCH_RUN_STORAGE_BENCHMARK=1` and the same credentials used by integration tests:

```bash
AZUREFETCH_RUN_STORAGE_BENCHMARK=1 \
AZUREFETCH_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=..." \
bun run bench:storage
```

Adjust iterations and warmup with:

```bash
AZUREFETCH_BENCHMARK_ITERATIONS=10 \
AZUREFETCH_BENCHMARK_WARMUP=2 \
AZUREFETCH_BENCHMARK_BATCH_SIZE=5 \
AZUREFETCH_BENCHMARK_DRIVER=native \
bun run bench:storage
```

Run against Azurite:

```bash
bun run bench:storage:azurite
```

## License

MIT
