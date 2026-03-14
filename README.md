# azurefetch

Minimal, dependency-free Azure credential helpers for token acquisition in modern runtimes.

## Usage

Import helpers from the package entrypoint:

```ts
import { getServicePrincipalToken } from "azurefetch";
import { getDefaultAzureCredentialToken } from "azurefetch";
import { getAuthorizationHeader } from "azurefetch";
```

### Default credential chain

`getDefaultAzureCredentialToken` tries credentials in this order:

1. managed identity (`/.default` scope)
2. environment service principal (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`)
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

### Blob compatibility APIs

For unstorage and lightweight migration scenarios, this package also exposes a small subset of Azure Storage Blob APIs:

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
const blob = container.getBlockBlobClient("greeting.txt");

await blob.upload("hello");
const response = await blob.download(0, 5);
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

Supported compatibility surface:

| Client                       | Methods                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `DefaultAzureCredential`     | `getToken`, `getAuthorizationHeader`                                                                     |
| `StorageSharedKeyCredential` | constructor, `computeHMACSHA256`                                                                         |
| `AccountSASPermissions`      | `parse`, `toString`                                                                                      |
| `BlobServiceClient`          | `fromConnectionString`, `getContainerClient`, `generateAccountSasUrl`, `listContainers().byPage(...)`    |
| `ContainerClient`            | `createIfNotExists`, `deleteIfExists`, `exists`, `listBlobsFlat().byPage(...)`                           |
| `BlockBlobClient`            | `upload`, `download`, `downloadToBuffer`, `deleteIfExists`, `exists`, `getProperties`                    |
| `TableServiceClient`         | `fromConnectionString`, `getTableClient`, `createTableIfNotExists`, `deleteTableIfNotExists`             |
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

The integration suite validates create/list/read/write/delete for blobs and tables and removes all created resources in cleanup.

## License

MIT
