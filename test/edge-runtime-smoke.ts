import { readFile } from "node:fs/promises";

const rootBundleUrl = new URL("../dist/index.mjs", import.meta.url);
const blobBundleUrl = new URL("../dist/blob.mjs", import.meta.url);
const keyVaultBundleUrl = new URL("../dist/keyvault-secrets.mjs", import.meta.url);
const tableBundleUrl = new URL("../dist/table.mjs", import.meta.url);

await assertNoNodeBuiltinLeakage();
await assertRootBundleImportsWithoutNodeGlobals();
await assertBlobAndTableBundlesSupportEdgeSafeAuthPaths();
await assertKeyVaultBundleSupportsEdgeSafeAuthPaths();

async function assertNoNodeBuiltinLeakage(): Promise<void> {
  const bundle = await readFile(rootBundleUrl, "utf8");
  for (const forbiddenSnippet of ["node:", "child_process"]) {
    if (bundle.includes(forbiddenSnippet)) {
      throw new Error(`Root bundle must stay edge-safe, found ${forbiddenSnippet} in dist/index.mjs`);
    }
  }
}

async function assertRootBundleImportsWithoutNodeGlobals(): Promise<void> {
  await withNodeGlobalsDisabled(async () => {
    const rootModule = (await import(`${rootBundleUrl.href}?edge-smoke=${Date.now()}`)) as Record<string, unknown>;

    for (const requiredExport of ["AzureClient", "downloadText", "uploadText"]) {
      if (!(requiredExport in rootModule)) {
        throw new Error(`Expected ${requiredExport} to remain available from the root bundle`);
      }
    }

    for (const forbiddenExport of [
      "AccountSASPermissions",
      "BlobBatch",
      "BlobBatchClient",
      "BlobServiceClient",
      "ContainerClient",
      "KeyVaultSecretClient",
      "StorageSharedKeyCredential",
      "TableClient",
      "TableServiceClient",
      "getAccountNameFromUrl",
    ]) {
      if (forbiddenExport in rootModule) {
        throw new Error(`Root bundle should not expose ${forbiddenExport}; use an explicit subpath import instead`);
      }
    }
  });
}

async function assertKeyVaultBundleSupportsEdgeSafeAuthPaths(): Promise<void> {
  await withNodeGlobalsDisabled(async () => {
    const { KeyVaultSecretClient } = (await import(`${keyVaultBundleUrl.href}?edge-smoke=${Date.now()}`)) as {
      KeyVaultSecretClient: typeof import("../src/keyvault-secrets").KeyVaultSecretClient;
    };

    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetcher: typeof globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const requestHeaders = input instanceof Request ? input.headers : new Headers(init.headers);
      requests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        headers: new Headers(requestHeaders),
      });
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
    };

    const client = new KeyVaultSecretClient(
      "https://example.vault.azure.net",
      { getAuthorizationHeader: async () => "Bearer edge-token" },
      { fetch: fetcher },
    );

    const secret = await client.getSecret("edge-secret");

    if (secret.value !== "edge-value") {
      throw new Error("Expected Key Vault secret value to round-trip in edge smoke test");
    }

    if (requests.length !== 1) {
      throw new Error(`Expected 1 Key Vault request, received ${requests.length}`);
    }

    const request = requests[0];
    if (request.url !== "https://example.vault.azure.net/secrets/edge-secret/?api-version=7.6") {
      throw new Error(`Unexpected Key Vault request URL ${request.url}`);
    }

    if (request.headers.get("Authorization") !== "Bearer edge-token") {
      throw new Error("Expected bearer auth header for Key Vault edge smoke request");
    }
  });
}

async function assertBlobAndTableBundlesSupportEdgeSafeAuthPaths(): Promise<void> {
  await withNodeGlobalsDisabled(async () => {
    const { BlobServiceClient } = (await import(`${blobBundleUrl.href}?edge-smoke=${Date.now()}`)) as {
      BlobServiceClient: typeof import("../src/blob").BlobServiceClient;
    };
    const { TableServiceClient } = (await import(`${tableBundleUrl.href}?edge-smoke=${Date.now()}`)) as {
      TableServiceClient: typeof import("../src/table").TableServiceClient;
    };

    const tokenRequests: Array<{ url: string; headers: Headers }> = [];
    const sasRequests: Array<{ url: string; headers: Headers }> = [];
    const tokenFetch: typeof globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      tokenRequests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        headers: new Headers(init.headers),
      });
      return new Response("", { status: 201, statusText: "Created" });
    };
    const sasFetch: typeof globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      sasRequests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        headers: new Headers(init.headers),
      });
      return new Response("", { status: 201, statusText: "Created" });
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

    if (tokenRequests.length !== 2) {
      throw new Error(`Expected 2 token-auth requests, received ${tokenRequests.length}`);
    }

    for (const request of tokenRequests) {
      if (request.headers.get("Authorization") !== "Bearer edge-token") {
        throw new Error(`Expected bearer auth for ${request.url}`);
      }
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

  globalObject.process = undefined;
  globalObject.Buffer = undefined;

  try {
    return await fn();
  } finally {
    globalObject.process = originalProcess;
    globalObject.Buffer = originalBuffer;
  }
}
