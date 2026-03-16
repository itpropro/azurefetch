import { readFile } from "node:fs/promises";

const rootBundleUrl = new URL("../dist/index.mjs", import.meta.url);

await assertNoNodeBuiltinLeakage();
await assertRootBundleImportsWithoutNodeGlobals();
await assertRootBundleSupportsEdgeSafeServiceClients();

async function assertNoNodeBuiltinLeakage(): Promise<void> {
  const bundle = await readFile(rootBundleUrl, "utf8");
  for (const forbiddenSnippet of ['from "node:', "from 'node:", 'import("node:', "import('node:", "child_process"]) {
    if (bundle.includes(forbiddenSnippet)) {
      throw new Error(`Root bundle must stay edge-safe, found ${forbiddenSnippet} in dist/index.mjs`);
    }
  }
}

async function assertRootBundleImportsWithoutNodeGlobals(): Promise<void> {
  await withNodeGlobalsDisabled(async () => {
    const rootModule = (await import(`${rootBundleUrl.href}?edge-smoke=${Date.now()}`)) as Record<string, unknown>;

    for (const requiredExport of [
      "AzureClient",
      "BlobServiceClient",
      "TableServiceClient",
      "KeyVaultSecretClient",
      "AppConfigurationClient",
      "DefaultAzureCredential",
      "getDefaultAzureCredentialToken",
      "StorageSharedKeyCredential",
      "downloadText",
      "uploadText",
    ]) {
      if (!(requiredExport in rootModule)) {
        throw new Error(`Expected ${requiredExport} to remain available from the root bundle`);
      }
    }
  });
}

async function assertRootBundleSupportsEdgeSafeServiceClients(): Promise<void> {
  await withNodeGlobalsDisabled(async () => {
    const rootModule = (await import(
      `${rootBundleUrl.href}?edge-smoke=${Date.now()}`
    )) as typeof import("../src/index");
    const { AppConfigurationClient, BlobServiceClient, KeyVaultSecretClient, TableServiceClient } = rootModule;

    const tokenRequests: Array<{ url: string; headers: Headers }> = [];
    const sasRequests: Array<{ url: string; headers: Headers }> = [];
    const appConfigurationRequests: Array<{ url: string; headers: Headers }> = [];

    const tokenFetch: typeof globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const requestHeaders = input instanceof Request ? input.headers : new Headers(init.headers);
      tokenRequests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        headers: new Headers(requestHeaders),
      });

      if (tokenRequests.length === 3) {
        return new Response(
          JSON.stringify({
            id: "https://example.vault.azure.net/secrets/edge-secret/version-1",
            value: "edge-value",
            attributes: {},
          }),
          {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response("", { status: 201, statusText: "Created" });
    };

    const sasFetch: typeof globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const requestHeaders = input instanceof Request ? input.headers : new Headers(init.headers);
      sasRequests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        headers: new Headers(requestHeaders),
      });
      return new Response("", { status: 201, statusText: "Created" });
    };

    const appConfigurationFetch: typeof globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const requestHeaders = input instanceof Request ? input.headers : new Headers(init.headers);
      appConfigurationRequests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        headers: new Headers(requestHeaders),
      });

      return new Response(JSON.stringify({ key: "edge-setting", value: "edge-value", etag: '"1"' }), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      });
    };

    const bearerCredential = {
      getAuthorizationHeader: async () => "Bearer edge-token",
    };

    const tokenBlobService = new BlobServiceClient("https://myaccount.blob.core.windows.net", bearerCredential, {
      fetch: tokenFetch,
    });
    await tokenBlobService.getContainerClient("edge-container").createIfNotExists();

    const tokenTableService = new TableServiceClient("https://myaccount.table.core.windows.net", bearerCredential, {
      fetch: tokenFetch,
    });
    await tokenTableService.createTableIfNotExists("edgetable");

    const keyVaultClient = new KeyVaultSecretClient(
      "https://example.vault.azure.net",
      { getAuthorizationHeader: async () => "Bearer edge-token" },
      { fetch: tokenFetch },
    );
    const secret = await keyVaultClient.getSecret("edge-secret");

    if (secret.value !== "edge-value") {
      throw new Error("Expected Key Vault secret value to round-trip in edge smoke test");
    }

    const appConfigurationClient = new AppConfigurationClient(
      "https://example.azconfig.io",
      { getAuthorizationHeader: async () => "Bearer edge-token" },
      { fetch: appConfigurationFetch },
    );
    const setting = await appConfigurationClient.getConfigurationSetting("edge-setting");

    if (setting.value !== "edge-value") {
      throw new Error("Expected App Configuration setting value to round-trip in edge smoke test");
    }

    const sasBlobService = BlobServiceClient.fromConnectionString(
      "BlobEndpoint=https://myaccount.blob.core.windows.net/;AccountName=myaccount;SharedAccessSignature=?sp=r&sv=2024-11-04&sig=testsig",
      { fetch: sasFetch },
    );
    await sasBlobService.getContainerClient("edge-container").createIfNotExists();

    const sasTableService = TableServiceClient.fromConnectionString(
      "TableEndpoint=https://myaccount.table.core.windows.net/;AccountName=myaccount;SharedAccessSignature=?sp=r&sv=2024-11-04&sig=testsig",
      { fetch: sasFetch },
    );
    await sasTableService.createTableIfNotExists("edgetable");

    if (tokenRequests.length !== 3) {
      throw new Error(`Expected 3 token-auth requests, received ${tokenRequests.length}`);
    }

    for (const request of tokenRequests) {
      if (request.headers.get("Authorization") !== "Bearer edge-token") {
        throw new Error(`Expected bearer auth for ${request.url}`);
      }
    }

    if (appConfigurationRequests.length !== 1) {
      throw new Error(`Expected 1 App Configuration request, received ${appConfigurationRequests.length}`);
    }

    const appConfigurationRequest = appConfigurationRequests[0]!;
    if (appConfigurationRequest.url !== "https://example.azconfig.io/kv/edge-setting?api-version=2023-11-01") {
      throw new Error(`Unexpected App Configuration request URL ${appConfigurationRequest.url}`);
    }

    if (appConfigurationRequest.headers.get("Authorization") !== "Bearer edge-token") {
      throw new Error("Expected bearer auth header for App Configuration edge smoke request");
    }

    if (sasRequests.length !== 2) {
      throw new Error(`Expected 2 SAS requests, received ${sasRequests.length}`);
    }

    for (const request of sasRequests) {
      const url = new URL(request.url);
      if (url.searchParams.get("sig") !== "testsig") {
        throw new Error(`Expected SAS signature on ${request.url}`);
      }

      if (request.headers.has("Authorization")) {
        throw new Error(`Did not expect Authorization header for SAS request ${request.url}`);
      }
    }
  });
}

async function withNodeGlobalsDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const globalObject = globalThis as typeof globalThis & {
    process?: unknown;
    Buffer?: unknown;
  };
  const originalProcess = globalObject.process;
  const originalBuffer = globalObject.Buffer;

  (globalObject as { process?: unknown }).process = undefined;
  (globalObject as { Buffer?: unknown }).Buffer = undefined;

  try {
    return await fn();
  } finally {
    globalObject.process = originalProcess;
    globalObject.Buffer = originalBuffer;
  }
}
