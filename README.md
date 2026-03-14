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
} from "azurefetch";

const service = new BlobServiceClient("https://myaccount.blob.core.windows.net", new DefaultAzureCredential());

const container = service.getContainerClient("my-container");
const blob = container.getBlockBlobClient("greeting.txt");

await blob.upload("hello");
const response = await blob.download(0, 5);
const text = await response.text();
```

Supported compatibility surface:

| Client                       | Methods                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `DefaultAzureCredential`     | `getToken`, `getAuthorizationHeader`                                                  |
| `StorageSharedKeyCredential` | constructor, `computeHMACSHA256`                                                      |
| `AccountSASPermissions`      | `parse`, `toString`                                                                   |
| `BlobServiceClient`          | `fromConnectionString`, `getContainerClient`, `generateAccountSasUrl`                 |
| `ContainerClient`            | `createIfNotExists`, `deleteIfExists`, `exists`, `listBlobsFlat().byPage(...)`        |
| `BlockBlobClient`            | `upload`, `download`, `downloadToBuffer`, `deleteIfExists`, `exists`, `getProperties` |
| Utilities                    | `getAccountNameFromUrl`                                                               |

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

## License

MIT
