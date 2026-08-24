import { describe, expect, test, vi } from "vitest";

import {
  AccountSASPermissions,
  BlobServiceClient,
  getAccountNameFromUrl,
  BlobBatch,
  BlobBatchClient,
  StorageSharedKeyCredential,
} from "../src/blob";
import { DefaultAzureCredential } from "../src/default-azure-credential";
import { createFetchMock, textResponse } from "./helpers";
import * as defaultCredential from "../src/default-credential";

describe("StorageSharedKeyCredential", () => {
  test("uses Web Crypto signing and caches the imported key", async () => {
    const cryptoKey = {} as CryptoKey;
    const importKey = vi.fn(async () => cryptoKey);
    const sign = vi.fn(async (_algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => {
      expect(key).toBe(cryptoKey);
      expect(new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))).toBe(
        "string-to-sign",
      );
      return new Uint8Array([1, 2, 3]);
    });

    vi.stubGlobal("crypto", {
      subtle: {
        importKey,
        sign,
      } as unknown as SubtleCrypto,
    } as Crypto);

    try {
      const credential = new StorageSharedKeyCredential("myaccount", "AQID");

      const first = await credential.computeHMACSHA256("string-to-sign");
      const second = await credential.computeHMACSHA256("string-to-sign");

      expect(first).toBe("AQID");
      expect(second).toBe("AQID");
      expect(importKey).toHaveBeenCalledTimes(1);
      expect(sign).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("AccountSASPermissions", () => {
  test("parses and serializes permission sets", () => {
    const permissions = AccountSASPermissions.parse("rwdlaf");

    expect(permissions.list).toBe(true);
    expect(permissions.read).toBe(true);
    expect(permissions.write).toBe(true);
    expect(permissions.delete).toBe(true);
    expect(permissions.permanentDelete).toBe(false);
    expect(permissions.deleteVersion).toBe(false);
    expect(permissions.add).toBe(true);

    expect(permissions.toString()).toBe("rwdfla");
  });

  test("rejects invalid permission characters", () => {
    expect(() => AccountSASPermissions.parse("q")).toThrow("Invalid permission character: q");
  });
});

describe("getAccountNameFromUrl", () => {
  test("parses host-style endpoints", () => {
    expect(getAccountNameFromUrl("https://myaccount.blob.core.windows.net/container")).toBe("myaccount");
  });

  test("parses ip-style endpoints", () => {
    expect(getAccountNameFromUrl("http://127.0.0.1:10000/devstoreaccount1/container")).toBe("devstoreaccount1");
  });
});

describe("BlobServiceClient.fromConnectionString", () => {
  test("creates shared-key clients from account connection strings", () => {
    const client = BlobServiceClient.fromConnectionString(
      "DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=bXlfYWNjb3VudF9rZXk=;EndpointSuffix=core.windows.net",
    );

    expect(client.accountName).toBe("myaccount");
    expect(client.url).toBe("https://myaccount.blob.core.windows.net/");
  });

  test("appends SAS query for SAS connection strings", async () => {
    const client = BlobServiceClient.fromConnectionString(
      "BlobEndpoint=https://myaccount.blob.core.windows.net/;AccountName=myaccount;SharedAccessSignature=?sp=r&sv=2024-11-04",
    );

    const endpoint = new URL(client.url);

    expect(endpoint.searchParams.get("sp")).toBe("r");
    expect(endpoint.searchParams.get("sv")).toBe("2024-11-04");
  });

  test("supports development storage connection strings", () => {
    const client = BlobServiceClient.fromConnectionString(
      "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1/",
    );

    expect(client.accountName).toBe("devstoreaccount1");
    expect(client.url).toBe("http://127.0.0.1:10000/devstoreaccount1");
  });
});

describe("BlobServiceClient.generateAccountSasUrl", () => {
  test("signs a deterministic Account SAS with canonical fields", async () => {
    const credential = new StorageSharedKeyCredential("myaccount", "AQID");
    const computeHMACSHA256 = vi.spyOn(credential, "computeHMACSHA256").mockResolvedValue("+/==");
    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", credential);

    const sasUrl = await client.generateAccountSasUrl(new Date("2030-01-01T00:00:00.000Z"), {
      permissions: "lwr",
      services: "fb",
      resourceTypes: "ocs",
      protocol: "https,http",
    });

    expect(computeHMACSHA256).toHaveBeenCalledWith(
      "myaccount\nrwl\nbf\nsco\n\n2030-01-01T00:00:00Z\n\nhttps,http\n2024-11-04\n\n",
    );
    expect(new URL(sasUrl).search).toBe(
      "?sp=rwl&ss=bf&srt=sco&sv=2024-11-04&se=2030-01-01T00%3A00%3A00Z&spr=https%2Chttp&sig=%2B%2F%3D%3D",
    );
  });

  test("rejects credentials that cannot sign Account SAS tokens", async () => {
    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net");

    await expect(client.generateAccountSasUrl(new Date("2030-01-01T00:00:00Z"), { permissions: "r" })).rejects.toThrow(
      "requires a StorageSharedKeyCredential",
    );
  });

  test.each([
    ["invalid expiry", new Date(Number.NaN), { permissions: "r" }],
    ["empty permissions", new Date("2030-01-01T00:00:00Z"), { permissions: "" }],
    ["invalid permissions", new Date("2030-01-01T00:00:00Z"), { permissions: "q" }],
    ["invalid services", new Date("2030-01-01T00:00:00Z"), { permissions: "r", services: "z" }],
    ["empty services", new Date("2030-01-01T00:00:00Z"), { permissions: "r", services: "" }],
    ["invalid resource types", new Date("2030-01-01T00:00:00Z"), { permissions: "r", resourceTypes: "z" }],
    ["empty resource types", new Date("2030-01-01T00:00:00Z"), { permissions: "r", resourceTypes: "" }],
    ["unsupported protocol", new Date("2030-01-01T00:00:00Z"), { permissions: "r", protocol: "http" }],
  ])("rejects %s", async (_name, expiry, options) => {
    const credential = new StorageSharedKeyCredential("myaccount", "AQID");
    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", credential);

    await expect(client.generateAccountSasUrl(expiry, options)).rejects.toThrow();
  });
});

describe("Blob Shared Key content length canonicalization", () => {
  test.each([
    { name: "zero", body: "", wireContentLength: "0", signedContentLength: "" },
    { name: "absent", body: undefined, wireContentLength: null, signedContentLength: "" },
    { name: "nonzero", body: "abc", wireContentLength: "3", signedContentLength: "3" },
  ])("canonicalizes $name content length", async ({ body, wireContentLength, signedContentLength }) => {
    let requestHeaders: Headers | undefined;
    const fetcher = createFetchMock([
      (_url, init) => {
        requestHeaders = new Headers(init.headers);
        return textResponse("", 201);
      },
    ]);
    const credential = new StorageSharedKeyCredential("myaccount", "AQID");
    const computeHMACSHA256 = vi.spyOn(credential, "computeHMACSHA256").mockResolvedValue("signature");
    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", credential, { fetch: fetcher });

    await client.request("PUT", "https://myaccount.blob.core.windows.net/container/blob", {
      headers: { "x-ms-date": "Mon, 24 Aug 2026 12:00:00 GMT" },
      body,
    });

    expect(requestHeaders?.get("Content-Length") ?? null).toBe(wireContentLength);
    expect(computeHMACSHA256).toHaveBeenCalledWith(
      [
        "PUT",
        "",
        "",
        signedContentLength,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "x-ms-date:Mon, 24 Aug 2026 12:00:00 GMT\nx-ms-version:2024-11-04",
        "/myaccount/container/blob",
      ].join("\n"),
    );
  });
});

describe("BlockBlobClient", () => {
  test("uploads content and sets shared-key auth header", async () => {
    const headers: HeadersInit[] = [];
    const fetcher = createFetchMock([
      (url, init) => {
        headers.push(init.headers as HeadersInit);
        return textResponse("", 201);
      },
    ]);

    const credential = new StorageSharedKeyCredential("myaccount", Buffer.from("my-key").toString("base64"));
    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", credential, {
      fetch: fetcher,
    });
    const blobClient = client.getContainerClient("container").getBlockBlobClient("hello/world.txt");

    const response = await blobClient.upload("héllo");
    expect(response.status).toBe(201);

    const capturedHeaders = new Headers(headers[0]);
    expect(capturedHeaders.get("Authorization")).toMatch(/^SharedKey myaccount:/);
    expect(capturedHeaders.get("x-ms-date")).toBeTruthy();
    expect(capturedHeaders.get("x-ms-version")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(capturedHeaders.get("Content-Length")).toBe(String(new TextEncoder().encode("héllo").byteLength));
  });

  test("download returns the native Response", async () => {
    const fetcher = createFetchMock([() => textResponse("payload", 206)]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const blobClient = client.getContainerClient("container").getBlockBlobClient("file.txt");

    const response = await blobClient.download(0, 3);

    expect(response instanceof Response).toBe(true);
    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe("payload");
  });

  test("returns false when a blob is missing", async () => {
    const fetcher = createFetchMock([() => textResponse("", 404)]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const blobClient = client.getContainerClient("container").getBlockBlobClient("missing.txt");

    await expect(blobClient.exists()).resolves.toBe(false);
  });

  test("maps 404 to false for deleteIfExists", async () => {
    const fetcher = createFetchMock([() => textResponse("", 404)]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const blobClient = client.getContainerClient("container").getBlockBlobClient("gone.txt");

    const response = await blobClient.deleteIfExists();

    expect(response).toMatchObject({
      succeeded: false,
      errorCode: "BlobNotFound",
    });
  });

  test("maps success status codes for deleteIfExists", async () => {
    const fetcher = createFetchMock([() => textResponse("", 202)]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const blobClient = client.getContainerClient("container").getBlockBlobClient("file.txt");

    const response = await blobClient.deleteIfExists();

    expect(response).toEqual({ succeeded: true });
  });

  test("reads metadata and timestamps from blob properties", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const fetcher = createFetchMock([
      () => {
        return new Response("", {
          status: 200,
          headers: {
            etag: '"etag"',
            "last-modified": now.toUTCString(),
            "x-ms-meta-foo": "bar",
            "x-ms-creation-time": now.toUTCString(),
          },
        });
      },
    ]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const blobClient = client.getContainerClient("container").getBlockBlobClient("file.txt");
    const properties = await blobClient.getProperties();

    expect(properties).toMatchObject({
      etag: '"etag"',
      metadata: {
        foo: "bar",
      },
    });
    expect(properties.lastModified?.toUTCString()).toBe(now.toUTCString());
    expect(properties.createdOn?.toUTCString()).toBe(now.toUTCString());
  });
});

describe("ContainerClient.listBlobsFlat", () => {
  test("caps maxPageSize to Azure service limits", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(url);
        return textResponse("<EnumerationResults><Blobs></Blobs><NextMarker></NextMarker></EnumerationResults>");
      },
    ]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const container = client.getContainerClient("container");

    for await (const _ of container.listBlobsFlat().byPage({ maxPageSize: 10_000 })) {
      // no-op
    }

    expect(requests).toHaveLength(1);
    const request = new URL(requests[0]);
    expect(request.searchParams.get("maxresults")).toBe("5000");
  });

  test("supports byPage continuation paging", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(url);
        return textResponse(
          "<EnumerationResults><Blobs><Blob><Name>first</Name></Blob></Blobs><NextMarker>marker</NextMarker></EnumerationResults>",
        );
      },
      () =>
        textResponse(
          "<EnumerationResults><Blobs><Blob><Name>second</Name></Blob></Blobs><NextMarker></NextMarker></EnumerationResults>",
        ),
    ]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const container = client.getContainerClient("container");

    const pages = [] as Array<{ name: string }[]>;
    const continuationTokens: Array<string | undefined> = [];
    for await (const page of container.listBlobsFlat().byPage({ maxPageSize: 1 })) {
      continuationTokens.push(page.continuationToken);
      pages.push(page.segment.blobItems);
    }

    expect(pages).toEqual([[{ name: "first" }], [{ name: "second" }]]);
    const firstRequest = new URL(requests[0]);
    expect(firstRequest.searchParams.get("maxresults")).toBe("1");
    expect(firstRequest.searchParams.get("comp")).toBe("list");
    expect(firstRequest.searchParams.get("restype")).toBe("container");
    expect(continuationTokens).toEqual(["marker", ""]);
  });

  test("uses explicit continuation token for a single final page", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(url);
        return textResponse(
          "<EnumerationResults><Blobs><Blob><Name>only</Name></Blob></Blobs><NextMarker></NextMarker></EnumerationResults>",
        );
      },
    ]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const container = client.getContainerClient("container");

    const pages = [] as string[][];
    for await (const page of container.listBlobsFlat().byPage({ continuationToken: "start token", maxPageSize: 1 })) {
      pages.push(page.segment.blobItems.map((item) => item.name));
    }

    expect(pages).toEqual([["only"]]);
    expect(requests).toHaveLength(1);
    const request = new URL(requests[0]);
    expect(request.searchParams.get("marker")).toBe("start token");
  });

  test("supports empty listing without additional requests", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(url);
        return textResponse("<EnumerationResults><Blobs></Blobs><NextMarker></NextMarker></EnumerationResults>");
      },
    ]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const container = client.getContainerClient("container");

    const pages = [] as string[][];
    for await (const page of container.listBlobsFlat().byPage()) {
      pages.push(page.segment.blobItems.map((item) => item.name));
    }

    expect(pages).toEqual([[]]);
    expect(requests).toHaveLength(1);
  });

  test("skips malformed blob entries and decodes xml entities", async () => {
    const fetcher = createFetchMock([
      () =>
        textResponse(
          "<EnumerationResults><Blobs><Blob><Name>first</Name></Blob><Blob><Properties /></Blob><Blob><Name>name &lt;with&gt; tag</Name></Blob></Blobs><NextMarker>   </NextMarker></EnumerationResults>",
        ),
    ]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const container = client.getContainerClient("container");

    const pages = [] as string[][];
    for await (const page of container.listBlobsFlat().byPage()) {
      pages.push(page.segment.blobItems.map((item) => item.name));
    }

    expect(pages).toEqual([["first", "name <with> tag"]]);
    expect(pages[0][1]).toBe("name <with> tag");
    expect(pages[0]).toHaveLength(2);
    expect(pages[0][1]).toContain("<with>");
  });
});

describe("BlobServiceClient.listContainers", () => {
  test("caps maxPageSize to Azure service limits", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(url);
        return textResponse(
          "<EnumerationResults><Containers><Container><Name>container</Name></Container></Containers><NextMarker></NextMarker></EnumerationResults>",
        );
      },
    ]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });

    for await (const _ of client.listContainers().byPage({ maxPageSize: 9_999 })) {
      // no-op
    }

    expect(requests).toHaveLength(1);
    const request = new URL(requests[0]);
    expect(request.searchParams.get("maxresults")).toBe("5000");
  });

  test("supports byPage continuation paging", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(url);
        return textResponse(
          "<EnumerationResults><Containers><Container><Name>container-one</Name></Container></Containers><NextMarker>marker</NextMarker></EnumerationResults>",
        );
      },
      (url) => {
        requests.push(url);
        return textResponse(
          "<EnumerationResults><Containers><Container><Name>container-two</Name></Container></Containers><NextMarker></NextMarker></EnumerationResults>",
        );
      },
    ]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });

    const pages = [] as Array<{ name: string }[]>;
    const continuationTokens: Array<string | undefined> = [];
    for await (const page of client.listContainers().byPage({ maxPageSize: 1 })) {
      continuationTokens.push(page.continuationToken);
      pages.push(page.segment.containerItems);
    }

    expect(pages).toEqual([[{ name: "container-one" }], [{ name: "container-two" }]]);
    const firstRequest = new URL(requests[0]);
    expect(firstRequest.searchParams.get("comp")).toBe("list");
    expect(firstRequest.searchParams.get("maxresults")).toBe("1");
    const secondRequest = new URL(requests[1]);
    expect(secondRequest.searchParams.get("marker")).toBe("marker");
    expect(continuationTokens).toEqual(["marker", ""]);
  });

  test("supports explicit continuation token", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(url);
        return textResponse(
          "<EnumerationResults><Containers><Container><Name>container-b</Name></Container></Containers><NextMarker></NextMarker></EnumerationResults>",
        );
      },
    ]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });

    const pages = [] as Array<string[]>;
    for await (const page of client.listContainers().byPage({ continuationToken: "start-token", maxPageSize: 1 })) {
      pages.push(page.segment.containerItems.map((item) => item.name));
    }

    expect(pages).toEqual([["container-b"]]);
    expect(requests).toHaveLength(1);
    const request = new URL(requests[0]);
    expect(request.searchParams.get("marker")).toBe("start-token");
  });
});

describe("DefaultAzureCredential", () => {
  test("reuses access token for repeated calls", async () => {
    const token = {
      token: "cached-token",
      tokenType: "Bearer" as const,
      expiresOnTimestamp: Date.now() + 600_000,
    };

    const credentialSpy = vi.spyOn(defaultCredential, "getDefaultAzureCredentialToken").mockResolvedValue(token);

    const credential = new DefaultAzureCredential();

    const first = await credential.getAuthorizationHeader("https://storage.azure.com/.default");
    const second = await credential.getAuthorizationHeader("https://storage.azure.com/.default");

    expect(first).toBe("Bearer cached-token");
    expect(second).toBe("Bearer cached-token");
    expect(credentialSpy).toHaveBeenCalledTimes(1);

    credentialSpy.mockRestore();
  });

  test("keeps separate caches per scope", async () => {
    const firstToken = {
      token: "scope-one",
      tokenType: "Bearer" as const,
      expiresOnTimestamp: Date.now() + 600_000,
    };
    const secondToken = {
      token: "scope-two",
      tokenType: "Bearer" as const,
      expiresOnTimestamp: Date.now() + 600_000,
    };

    const credentialSpy = vi.spyOn(defaultCredential, "getDefaultAzureCredentialToken");
    credentialSpy.mockImplementation(async (input) => {
      if (input.scope === "scope-one") {
        return firstToken;
      }

      return secondToken;
    });

    const credential = new DefaultAzureCredential();

    const first = await credential.getAuthorizationHeader("scope-one");
    const second = await credential.getAuthorizationHeader("scope-two");

    expect(first).toBe("Bearer scope-one");
    expect(second).toBe("Bearer scope-two");
    expect(credentialSpy).toHaveBeenCalledTimes(2);

    credentialSpy.mockRestore();
  });
});

describe("BlockBlobClient.downloadToBuffer", () => {
  test("downloads body directly into a Uint8Array", async () => {
    const payload = new TextEncoder().encode("hello-from-buffer");
    const fetcher = createFetchMock([
      () =>
        new Response(payload, {
          status: 200,
        }),
    ]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const blobClient = client.getContainerClient("container").getBlockBlobClient("file.txt");

    const buffer = await blobClient.downloadToBuffer(0);

    expect(buffer).toEqual(payload);
  });
});

describe("Blob Batch", () => {
  test("creates batch clients from service and container clients", () => {
    const serviceClient = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined);
    const serviceBatchClient = serviceClient.getBlobBatchClient();
    expect(serviceBatchClient).toBeInstanceOf(BlobBatchClient);

    const containerClient = serviceClient.getContainerClient("container");
    const containerBatchClient = containerClient.getBlobBatchClient();
    expect(containerBatchClient).toBeInstanceOf(BlobBatchClient);

    const batch = containerBatchClient.createBatch();
    expect(batch).toBeInstanceOf(BlobBatch);
  });

  test("submits a delete-only batch and parses sub responses", async () => {
    const requests: Array<{ url: string; method?: string; headers?: HeadersInit; body?: string }> = [];
    const boundary = "batchresponse_123";
    const responseBody = [
      `--${boundary}`,
      "Content-Type: application/http",
      "Content-ID: 0",
      "",
      "HTTP/1.1 202 Accepted",
      "x-ms-request-id: 123",
      "",
      `--${boundary}`,
      "Content-Type: application/http",
      "Content-ID: 1",
      "",
      "HTTP/1.1 404 Not Found",
      "x-ms-error-code: BlobNotFound",
      "",
      `--${boundary}--`,
    ].join("\r\n");

    const fetcher = createFetchMock([
      (url, init) => {
        requests.push({ url, method: init.method, headers: init.headers, body: init.body as string | undefined });
        return textResponse(responseBody, 202, "Accepted", {
          "content-type": `multipart/mixed; boundary=${boundary}`,
        });
      },
    ]);

    const client = new BlobServiceClient("https://myaccount.blob.core.windows.net", undefined, {
      fetch: fetcher,
    });
    const batchClient = client.getBlobBatchClient();

    const batch = batchClient.createBatch();
    await batch.deleteBlob("https://myaccount.blob.core.windows.net/container/one.txt", undefined, {
      deleteSnapshots: "include",
    });
    await batch.deleteBlob("https://myaccount.blob.core.windows.net/container/two.txt", undefined, {
      deleteSnapshots: "include",
    });

    const response = await batchClient.submitBatch(batch);

    expect(response.status).toBe(202);
    expect(response.subResponsesSucceededCount).toBe(1);
    expect(response.subResponsesFailedCount).toBe(1);
    expect(response.subResponses[0]?.status).toBe(202);
    expect(response.subResponses[1]?.status).toBe(404);
    expect(response.subResponses[1]?.errorCode).toBe("BlobNotFound");

    expect(response.subResponses[0]?._request?.method).toBe("DELETE");
    expect(response.subResponses[0]?._request?.headers["x-ms-delete-snapshots"]).toBe("include");

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.method).toBe("POST");

    const requestUrl = new URL(request.url);
    expect(requestUrl.searchParams.get("comp")).toBe("batch");

    const contentType = request.headers ? new Headers(request.headers as HeadersInit).get("content-type") : null;
    expect(contentType).toBeTruthy();
    expect(contentType).toContain("multipart/mixed; boundary=");

    const requestBody = request.body || "";
    expect(requestBody).toContain("DELETE /container/one.txt HTTP/1.1");
    expect(requestBody).toContain("DELETE /container/two.txt HTTP/1.1");
    expect(requestBody).toContain("x-ms-delete-snapshots: include");
    expect(requestBody).toContain("Content-ID: 0");
  });
});
