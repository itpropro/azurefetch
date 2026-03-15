import { describe, expect, test } from "vitest";

import {
  AzureClient,
  downloadJson,
  downloadText,
  getEntity,
  listEntitiesPage,
  uploadText,
  upsertEntity,
} from "../src/index";
import { createFetchMock, jsonResponse, textResponse } from "./helpers";

describe("uploadText", () => {
  test("sends PUT request with default text content type", async () => {
    const requests: Array<{ method?: string; headers: Headers; body: string }> = [];
    const fetcher = createFetchMock([
      (url, init) => {
        requests.push({
          method: init.method,
          headers: new Headers(init.headers as HeadersInit),
          body: init.body as string,
        });
        return textResponse("", 201);
      },
    ]);

    const client = new AzureClient({
      fetch: fetcher,
      credential: { getAuthorizationHeader: async () => "Bearer test" },
    });
    const response = await uploadText(client, "https://example.blob.core.windows.net/container/file.txt", "hello");

    expect(response.status).toBe(201);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(requests[0]?.body).toBe("hello");
  });

  test("throws on upload failure", async () => {
    const fetcher = createFetchMock([() => textResponse("failed", 500, "Server Error")]);
    const client = new AzureClient({
      fetch: fetcher,
      credential: { getAuthorizationHeader: async () => "Bearer test" },
    });

    await expect(
      uploadText(client, "https://example.blob.core.windows.net/container/file.txt", "hello"),
    ).rejects.toThrow("uploadText failed: 500 Server Error");
  });
});

describe("downloadText", () => {
  test("returns the response and decoded text", async () => {
    const fetcher = createFetchMock([() => textResponse("payload")]);
    const client = new AzureClient({
      fetch: fetcher,
      credential: { getAuthorizationHeader: async () => "Bearer test" },
    });

    const response = await downloadText(client, "https://example.blob.core.windows.net/container/file.txt");

    expect(response.response.status).toBe(200);
    expect(response.text).toBe("payload");
  });
});

describe("downloadJson", () => {
  test("parses JSON payloads", async () => {
    const fetcher = createFetchMock([() => textResponse('{"foo":"bar"}')]);
    const client = new AzureClient({
      fetch: fetcher,
      credential: { getAuthorizationHeader: async () => "Bearer test" },
    });

    const response = await downloadJson<{ foo: string }>(
      client,
      "https://example.blob.core.windows.net/container/file.json",
    );

    expect(response.value).toEqual({ foo: "bar" });
  });

  test("throws on JSON parse failure", async () => {
    const fetcher = createFetchMock([() => textResponse("not json")]);
    const client = new AzureClient({
      fetch: fetcher,
      credential: { getAuthorizationHeader: async () => "Bearer test" },
    });

    await expect(downloadJson(client, "https://example.blob.core.windows.net/container/file.json")).rejects.toThrow(
      "downloadJson failed",
    );
  });
});

describe("table getEntity", () => {
  test("returns the parsed entity for 200 responses", async () => {
    const fetcher = createFetchMock([() => jsonResponse({ PartitionKey: "pk", RowKey: "rk", value: "item" })]);
    const client = new AzureClient({
      fetch: fetcher,
      credential: { getAuthorizationHeader: async () => "Bearer test" },
    });

    const response = await getEntity(client, "https://example.table.core.windows.net/mytable", "pk", "rk", {
      headers: { "Content-Type": "application/json" },
    });

    expect(response.entity).toMatchObject({
      partitionKey: "pk",
      rowKey: "rk",
      value: "item",
    });
  });

  test("returns undefined for 404 responses", async () => {
    const fetcher = createFetchMock([() => textResponse("", 404, "Not Found")]);
    const client = new AzureClient({
      fetch: fetcher,
      credential: { getAuthorizationHeader: async () => "Bearer test" },
    });

    const missing = await getEntity(client, "https://example.table.core.windows.net/mytable", "missing", "rk");

    expect(missing).toMatchObject({
      response: expect.any(Response),
      entity: undefined,
    });
    expect(missing.response.status).toBe(404);
  });
});

describe("upsertEntity", () => {
  test("returns created false for successful PUT upsert", async () => {
    const fetcher = createFetchMock([() => textResponse("", 204)]);
    const client = new AzureClient({
      fetch: fetcher,
      credential: { getAuthorizationHeader: async () => "Bearer test" },
    });

    const response = await upsertEntity(client, "https://example.table.core.windows.net/mytable", {
      partitionKey: "pk",
      rowKey: "rk",
      count: 1,
    });

    expect(response).toEqual({
      response: expect.any(Response),
      created: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("falls back to POST when PUT not found", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(`PUT ${url}`);
        return textResponse("", 404, "Not Found");
      },
      (url) => {
        requests.push(`POST ${url}`);
        return textResponse("", 204);
      },
    ]);
    const client = new AzureClient({
      fetch: fetcher,
      credential: { getAuthorizationHeader: async () => "Bearer test" },
    });

    const response = await upsertEntity(client, "https://example.table.core.windows.net/mytable", {
      partitionKey: "pk",
      rowKey: "rk",
      count: 2,
    });

    expect(response.created).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe("PUT https://example.table.core.windows.net/mytable(PartitionKey='pk',RowKey='rk')");
    expect(requests[1]).toBe("POST https://example.table.core.windows.net/mytable");
  });
});

describe("listEntitiesPage", () => {
  test("caps maxPageSize to 1000 and follows continuation tokens", async () => {
    const requests: string[] = [];
    const fetcher = createFetchMock([
      (url) => {
        requests.push(url);
        return textResponse(
          '{"value":[{"PartitionKey":"pk1","RowKey":"rk1"},{"PartitionKey":"pk2","RowKey":"rk2"}]}',
          200,
          "OK",
          {
            "x-ms-continuation-NextPartitionKey": "nextPk",
            "x-ms-continuation-NextRowKey": "nextRk",
          },
        );
      },
      (url) => {
        requests.push(url);
        return textResponse('{"value":[{"PartitionKey":"pk3","RowKey":"rk3"}]}');
      },
    ]);
    const client = new AzureClient({
      fetch: fetcher,
      credential: { getAuthorizationHeader: async () => "Bearer test" },
    });

    const pages = [] as Array<{ entities: Array<Record<string, unknown>> }>;
    const tokens = [] as Array<string | undefined>;
    for await (const page of listEntitiesPage(client, "https://example.table.core.windows.net/mytable", {
      maxPageSize: 2000,
    })) {
      pages.push(page);
      tokens.push(page.continuationToken);
    }

    const firstRequest = new URL(requests[0]);
    const secondRequest = new URL(requests[1]);

    expect(firstRequest.searchParams.get("$top")).toBe("1000");
    expect(firstRequest.searchParams.get("NextPartitionKey")).toBeNull();
    expect(firstRequest.searchParams.get("NextRowKey")).toBeNull();
    expect(secondRequest.searchParams.get("NextPartitionKey")).toBe("nextPk");
    expect(secondRequest.searchParams.get("NextRowKey")).toBe("nextRk");
    expect(tokens).toEqual(["NextPartitionKey=nextPk&NextRowKey=nextRk", undefined]);
    expect(pages).toHaveLength(2);
    expect(pages[0].entities).toEqual([
      { partitionKey: "pk1", rowKey: "rk1" },
      { partitionKey: "pk2", rowKey: "rk2" },
    ]);
  });
});
