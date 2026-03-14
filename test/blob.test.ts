import { describe, expect, test } from "vitest";

import {
  AccountSASPermissions,
  BlobServiceClient,
  getAccountNameFromUrl,
  StorageSharedKeyCredential,
} from "../src/blob";

type FetchMock = typeof globalThis.fetch;

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

function createFetchMock(handlers: FetchHandler[]): FetchMock {
  let call = 0;

  return ((url: string, init: RequestInit = {}) => {
    const handler = handlers[call];
    call += 1;

    if (handler == null) {
      throw new Error(`Unexpected fetch call ${call}`);
    }

    return Promise.resolve(handler(String(url), init));
  }) as FetchMock;
}

function textResponse(body: string, status = 200, statusText = "OK"): Response {
  return new Response(body, {
    status,
    statusText,
  });
}

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
    const client = BlobServiceClient.fromConnectionString("UseDevelopmentStorage=true");

    expect(client.accountName).toBe("devstoreaccount1");
    expect(client.url).toBe("http://127.0.0.1:10000/devstoreaccount1");
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
    expect(capturedHeaders.get("x-ms-version")).toBe("2024-11-04");
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
    expect(requests[0]).toContain("maxresults=1");
    expect(requests[0]).toContain("comp=list");
    expect(requests[0]).toContain("restype=container");
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
    expect(requests[0]).toContain("marker=start+token");
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
