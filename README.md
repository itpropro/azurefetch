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
