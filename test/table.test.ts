import { describe, expect, test, vi } from "vitest";

import { TableClient, TableServiceClient } from "../src/table";
import { StorageSharedKeyCredential } from "../src/blob";
import { DefaultAzureCredential as BlobDefaultAzureCredential } from "../src/default-azure-credential";
import { createFetchMock, textResponse } from "./helpers";

describe("TableServiceClient.fromConnectionString", () => {
  test("creates shared-key clients from account connection strings", () => {
    const client = TableServiceClient.fromConnectionString(
      "DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=bXlfYWNjb3VudF9rZXk=;EndpointSuffix=core.windows.net",
    );

    expect(client.accountName).toBe("myaccount");
    expect(client.url).toBe("https://myaccount.table.core.windows.net/");
  });

  test("appends SAS query for SAS connection strings", () => {
    const client = TableServiceClient.fromConnectionString(
      "TableEndpoint=https://myaccount.table.core.windows.net/;AccountName=myaccount;SharedAccessSignature=?sp=r&sv=2024-11-04",
    );

    const endpoint = new URL(client.url);

    expect(endpoint.searchParams.get("sp")).toBe("r");
    expect(endpoint.searchParams.get("sv")).toBe("2024-11-04");
  });

  test("supports development storage connection strings", () => {
    const client = TableServiceClient.fromConnectionString(
      "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:10002/devstoreaccount1/",
    );

    expect(client.accountName).toBe("devstoreaccount1");
    expect(client.url).toBe("http://127.0.0.1:10002/devstoreaccount1");
  });
});

describe("TableServiceClient", () => {
  test("uses shared-key signing for table requests", async () => {
    const headers: HeadersInit[] = [];
    const fetcher = createFetchMock([
      (url, init) => {
        headers.push(init.headers || {});
        return textResponse('{"PartitionKey":"pk","RowKey":"rk","name":"item"}');
      },
    ]);

    const credential = new StorageSharedKeyCredential("myaccount", Buffer.from("my-key").toString("base64"));
    const client = new TableServiceClient("https://myaccount.table.core.windows.net", credential, {
      fetch: fetcher,
    });
    const table = client.getTableClient("mytable");

    const response = await table.getEntity("pk", "rk");

    expect(response).toEqual({
      partitionKey: "pk",
      rowKey: "rk",
      name: "item",
    });

    const capturedHeaders = new Headers(headers[0]);
    expect(capturedHeaders.get("Authorization")).toMatch(/^SharedKeyLite myaccount:/);
    expect(capturedHeaders.get("x-ms-date")).toBeTruthy();
    expect(capturedHeaders.get("x-ms-version")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(capturedHeaders.get("DataServiceVersion")).toBe("3.0;NetFx");
    expect(capturedHeaders.get("MaxDataServiceVersion")).toBe("3.0;NetFx");
  });

  test("uses AAD bearer token auth when DefaultAzureCredential is configured", async () => {
    const headers: HeadersInit[] = [];
    const fetcher = createFetchMock([
      (url, init) => {
        headers.push(init.headers || {});
        return textResponse("", 201);
      },
    ]);

    const credential = new BlobDefaultAzureCredential();
    credential.getAuthorizationHeader = async () => "Bearer token-value";

    const client = new TableServiceClient("https://myaccount.table.core.windows.net", credential, {
      fetch: fetcher,
    });

    await client.createTableIfNotExists("mytable");

    const capturedHeaders = new Headers(headers[0]);
    expect(capturedHeaders.get("Authorization")).toBe("Bearer token-value");
  });

  test("deletes a table when it exists", async () => {
    const fetcher = createFetchMock([() => textResponse("", 204)]);
    const client = new TableServiceClient("https://myaccount.table.core.windows.net", undefined, {
      fetch: fetcher,
    });

    const response = await client.deleteTableIfExists("my-table");

    expect(response).toEqual({ succeeded: true });
  });

  test("maps table not found to failed delete response", async () => {
    const fetcher = createFetchMock([() => textResponse("", 404)]);
    const client = new TableServiceClient("https://myaccount.table.core.windows.net", undefined, {
      fetch: fetcher,
    });

    const response = await client.deleteTableIfExists("missing-table");

    expect(response).toEqual({
      succeeded: false,
      errorCode: "TableNotFound",
    });
  });
});

describe("TableClient", () => {
  test("caps table maxPageSize to service limits", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(url);
        return textResponse(
          '{"value":[{"PartitionKey":"pk","RowKey":"rk"}],"odata.nextLink":"https://continuation"}',
          200,
        );
      },
    ]);

    const client = new TableClient(
      "https://myaccount.table.core.windows.net/mytable",
      "mytable",
      undefined,
      fetcher,
      "https://myaccount.table.core.windows.net",
    );

    const pages: Array<Array<unknown>> = [];
    for await (const page of client.list().byPage({ maxPageSize: 2_000 })) {
      pages.push(page.value);
    }

    expect(pages).toEqual([[{ partitionKey: "pk", rowKey: "rk" }]]);
    expect(requests).toHaveLength(1);
    const request = new URL(requests[0]);
    expect(request.searchParams.get("$top")).toBe("1000");
  });

  test("creates table via service client from table client", async () => {
    const fetcher = createFetchMock([() => textResponse("", 409)]);
    const credential = new StorageSharedKeyCredential("myaccount", Buffer.from("my-key").toString("base64"));
    const client = new TableClient(
      "https://myaccount.table.core.windows.net/mytable",
      "mytable",
      credential,
      fetcher,
      "https://myaccount.table.core.windows.net",
    );

    const response = await client.createIfNotExists();

    expect(response).toMatchObject({
      succeeded: false,
      errorCode: "TableAlreadyExists",
    });
  });

  test("upsert replace sends partition/row keys and If-Match", async () => {
    const captured: Array<{ url: string; method?: string; body?: string; headers?: HeadersInit }> = [];
    const fetcher = createFetchMock([
      (url, init) => {
        captured.push({ url, method: init.method, body: init.body as string | undefined, headers: init.headers });
        return textResponse("", 200);
      },
    ]);

    const client = new TableClient(
      "https://myaccount.table.core.windows.net/mytable",
      "mytable",
      undefined,
      fetcher,
      "https://myaccount.table.core.windows.net",
    );

    await client.upsertEntity(
      {
        partitionKey: "pk",
        rowKey: "r/1",
        label: "item",
      },
      "Replace",
    );

    expect(captured[0].method).toBe("PUT");
    expect(captured[0].url).toContain("/mytable(PartitionKey='pk',RowKey='r%2F1')");

    const payload = JSON.parse(captured[0].body || "{}");
    expect(payload).toEqual({ PartitionKey: "pk", RowKey: "r/1", label: "item" });

    const requestHeaders = new Headers(captured[0].headers || {});
    expect(requestHeaders.get("If-Match")).toBe("*");
  });

  test("falls back to insert when put upsert is missing", async () => {
    const captured: Array<{ url: string; method?: string; body?: string; headers?: HeadersInit }> = [];
    const fetcher = createFetchMock([
      (url, init) => {
        captured.push({ url, method: init.method, body: init.body as string | undefined, headers: init.headers });
        return textResponse("", 404);
      },
      (url, init) => {
        captured.push({ url, method: init.method, body: init.body as string | undefined, headers: init.headers });
        return textResponse("", 204);
      },
    ]);

    const client = new TableClient(
      "https://myaccount.table.core.windows.net/mytable",
      "mytable",
      undefined,
      fetcher,
      "https://myaccount.table.core.windows.net",
    );

    await client.upsertEntity({
      partitionKey: "pk",
      rowKey: "rk",
      label: "inserted",
    });

    expect(captured).toHaveLength(2);
    expect(captured[0].method).toBe("PUT");
    expect(captured[0].url).toContain("/mytable(PartitionKey='pk',RowKey='rk')");
    expect(captured[1].method).toBe("POST");
    expect(captured[1].url).toBe("https://myaccount.table.core.windows.net/mytable");

    const payload = JSON.parse(captured[1].body || "{}");
    expect(payload).toEqual({ PartitionKey: "pk", RowKey: "rk", label: "inserted" });
    const requestHeaders = new Headers(captured[1].headers || {});
    expect(requestHeaders.get("If-Match")).toBeNull();
  });

  test("returns false for missing entities", async () => {
    const fetcher = createFetchMock([() => textResponse("", 404)]);

    const client = new TableClient(
      "https://myaccount.table.core.windows.net",
      "mytable",
      undefined,
      fetcher,
      "https://myaccount.table.core.windows.net",
    );

    const entity = await client.getEntity("pk", "missing");

    expect(entity).toBeUndefined();
  });

  test("maps delete 404 to failed response", async () => {
    const fetcher = createFetchMock([() => textResponse("", 404)]);

    const client = new TableClient(
      "https://myaccount.table.core.windows.net",
      "mytable",
      undefined,
      fetcher,
      "https://myaccount.table.core.windows.net",
    );

    const response = await client.deleteEntity("pk", "rk");

    expect(response).toEqual({
      succeeded: false,
      errorCode: "ResourceNotFound",
    });
  });

  test("deletes the table when requested", async () => {
    const fetcher = createFetchMock([() => textResponse("", 204)]);

    const client = new TableClient(
      "https://myaccount.table.core.windows.net/mytable",
      "mytable",
      undefined,
      fetcher,
      "https://myaccount.table.core.windows.net",
    );

    const response = await client.deleteIfExists();

    expect(response).toEqual({ succeeded: true });
  });

  test("submits one atomic changeset and parses ordered subresponses", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    const fetcher = createFetchMock([
      (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return textResponse(transactionResponseBody([201, 204, 204, 204]), 202);
      },
    ]);

    const client = new TableClient(
      "https://myaccount.table.core.windows.net/my-table",
      "my-table",
      undefined,
      fetcher,
      "https://myaccount.table.core.windows.net",
    );

    const response = await client.submitTransaction([
      { action: "create", entity: { partitionKey: "partition-a", rowKey: "row-1", value: "created" } },
      {
        action: "update",
        entity: { partitionKey: "partition-a", rowKey: "row-4", value: "updated" },
      },
      {
        action: "upsert",
        entity: { partitionKey: "partition-a", rowKey: "row-2", value: "upserted" },
      },
      { action: "delete", partitionKey: "partition-a", rowKey: "row-3" },
    ]);

    expect(response.status).toBe(202);
    expect(response.subResponses).toEqual([{ status: 201 }, { status: 204 }, { status: 204 }, { status: 204 }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toBe("https://myaccount.table.core.windows.net/$batch");
    expect(capturedInit.method).toBe("POST");

    const headers = new Headers(capturedInit.headers);
    expect(headers.get("Content-Type")).toMatch(/^multipart\/mixed; boundary=batch_/);
    const body = String(capturedInit.body);
    expect(body).toMatch(/\r\n/);
    expect(body.match(/Content-Type: application\/http/g)).toHaveLength(4);
    expect(body).toContain("Content-ID: 1");
    const operations = body.split("Content-Type: application/http").slice(1);
    expect(operations[0]).toContain("POST https://myaccount.table.core.windows.net/my-table HTTP/1.1");
    expect(operations[0]).toContain('{"value":"created","PartitionKey":"partition-a","RowKey":"row-1"}');
    expect(operations[1]).toMatch(
      /PUT https:\/\/myaccount\.table\.core\.windows\.net\/my-table\(PartitionKey='partition-a',RowKey='row-4'\) HTTP\/1\.1[\s\S]*?If-Match: \*/,
    );
    expect(operations[2]).toContain(
      "PUT https://myaccount.table.core.windows.net/my-table(PartitionKey='partition-a',RowKey='row-2') HTTP/1.1",
    );
    expect(operations[2]).not.toContain("If-Match");
    expect(operations[3]).toMatch(
      /DELETE https:\/\/myaccount\.table\.core\.windows\.net\/my-table\(PartitionKey='partition-a',RowKey='row-3'\) HTTP\/1\.1[\s\S]*?If-Match: \*/,
    );
    expect(body).toMatch(/--changeset_[^\r\n]+--\r\n--batch_[^\r\n]+--\r\n$/);
  });

  test.each([
    ["empty batches", [], "at least one action"],
    [
      "more than 100 actions",
      Array.from({ length: 101 }, (_, index) => ({
        action: "create" as const,
        entity: { partitionKey: "partition", rowKey: `row-${index}` },
      })),
      "more than 100 actions",
    ],
    [
      "mixed partition keys",
      [
        { action: "create" as const, entity: { partitionKey: "one", rowKey: "row-1" } },
        { action: "delete" as const, partitionKey: "two", rowKey: "row-2" },
      ],
      "same partition key",
    ],
    [
      "duplicate entity targets",
      [
        { action: "create" as const, entity: { partitionKey: "one", rowKey: "row-1" } },
        { action: "delete" as const, partitionKey: "one", rowKey: "row-1" },
      ],
      "duplicate entity targets",
    ],
  ] as const)("rejects %s before dispatch", async (_case, actions, message) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createTableClient(fetcher);

    await expect(client.submitTransaction([...actions])).rejects.toThrow(message);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("rejects a transaction payload over 4 MiB before dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createTableClient(fetcher);

    await expect(
      client.submitTransaction([
        {
          action: "create",
          entity: { partitionKey: "partition", rowKey: "row", value: "x".repeat(4 * 1024 * 1024) },
        },
      ]),
    ).rejects.toThrow("must not exceed 4 MiB");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("surfaces a failed transaction subresponse", async () => {
    const fetcher = createFetchMock([() => textResponse(transactionResponseBody([201, 409]), 202)]);
    const client = createTableClient(fetcher);

    await expect(
      client.submitTransaction([
        { action: "create", entity: { partitionKey: "partition", rowKey: "row-1" } },
        { action: "create", entity: { partitionKey: "partition", rowKey: "row-2" } },
      ]),
    ).rejects.toThrow("subresponse returned 409");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("rejects malformed transaction responses instead of synthesizing success", async () => {
    const fetcher = createFetchMock([() => textResponse("", 202)]);
    const client = createTableClient(fetcher);

    await expect(
      client.submitTransaction([{ action: "delete", partitionKey: "partition", rowKey: "row" }]),
    ).rejects.toThrow("contained 0 subresponses; expected 1");
  });

  test("maps table delete if-not-exists response", async () => {
    const fetcher = createFetchMock([() => textResponse("", 404)]);

    const client = new TableClient(
      "https://myaccount.table.core.windows.net/mytable",
      "mytable",
      undefined,
      fetcher,
      "https://myaccount.table.core.windows.net",
    );

    const response = await client.deleteIfExists();

    expect(response).toEqual({
      succeeded: false,
      errorCode: "TableNotFound",
    });
  });

  test("list().byPage follows continuation tokens", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(url);
        return textResponse('{"value":[{"PartitionKey":"pk1","RowKey":"rk1"}]}', 200, "OK", {
          "x-ms-continuation-NextPartitionKey": "nextPk",
          "x-ms-continuation-NextRowKey": "nextRk",
        });
      },
      (url) => {
        requests.push(url);
        return textResponse('{"value":[{"PartitionKey":"pk3","RowKey":"rk3"}]}', 200);
      },
    ]);

    const client = new TableClient(
      "https://myaccount.table.core.windows.net/mytable",
      "mytable",
      undefined,
      fetcher,
      "https://myaccount.table.core.windows.net",
    );

    const pages = [] as Array<Array<unknown>>;
    const tokens = [] as Array<string | undefined>;
    for await (const page of client.list().byPage({ maxPageSize: 2 })) {
      pages.push(page.value);
      tokens.push(page.continuationToken);
      if (pages.length === 1) {
        expect(page.nextPartitionKey).toBe("nextPk");
        expect(page.nextRowKey).toBe("nextRk");
      }
    }

    expect(pages).toEqual([[{ partitionKey: "pk1", rowKey: "rk1" }], [{ partitionKey: "pk3", rowKey: "rk3" }]]);
    expect(tokens).toEqual(["NextPartitionKey=nextPk&NextRowKey=nextRk", undefined]);
    const firstRequest = new URL(requests[0]);
    expect(firstRequest.searchParams.get("$top")).toBe("2");
    expect(firstRequest.searchParams.get("NextPartitionKey")).toBeNull();
    expect(firstRequest.searchParams.get("NextRowKey")).toBeNull();

    const secondRequest = new URL(requests[1]);
    expect(secondRequest.searchParams.get("$top")).toBe("2");
    expect(secondRequest.searchParams.get("NextPartitionKey")).toBe("nextPk");
    expect(secondRequest.searchParams.get("NextRowKey")).toBe("nextRk");
  });
});

describe("TableClient.listEntities", () => {
  test("supports explicit continuation tokens", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(url);
        return textResponse('{"value":[{"PartitionKey":"pk","RowKey":"rk"}]}', 200);
      },
    ]);

    const client = new TableClient(
      "https://myaccount.table.core.windows.net",
      "mytable",
      undefined,
      fetcher,
      "https://myaccount.table.core.windows.net",
    );

    const pages = [] as Array<Array<unknown>>;
    for await (const page of client.listEntities().byPage({
      continuationToken: "NextPartitionKey=start&NextRowKey=row",
      maxPageSize: 1,
    })) {
      pages.push(page.value);
    }

    expect(pages).toEqual([[{ partitionKey: "pk", rowKey: "rk" }]]);
    expect(requests).toHaveLength(1);
    const request = new URL(requests[0]);
    expect(request.searchParams.get("NextPartitionKey")).toBe("start");
    expect(request.searchParams.get("NextRowKey")).toBe("row");
    expect(request.searchParams.get("$top")).toBe("1");
  });
});

function createTableClient(fetcher: typeof fetch): TableClient {
  return new TableClient(
    "https://myaccount.table.core.windows.net/my-table",
    "my-table",
    undefined,
    fetcher,
    "https://myaccount.table.core.windows.net",
  );
}

function transactionResponseBody(statuses: number[]): string {
  const lines = ["--batchresponse_test", "Content-Type: multipart/mixed; boundary=changesetresponse_test", ""];
  for (const status of statuses) {
    lines.push(
      "--changesetresponse_test",
      "Content-Type: application/http",
      "Content-Transfer-Encoding: binary",
      "",
      `HTTP/1.1 ${status} ${status >= 200 && status < 300 ? "Success" : "Failure"}`,
      "Content-Length: 0",
      "",
      "",
    );
  }
  lines.push("--changesetresponse_test--", "--batchresponse_test--", "");
  return lines.join("\r\n");
}
