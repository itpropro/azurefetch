import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { BlobServiceClient } from "../src/blob";
import { DefaultAzureCredential } from "../src/node";
import { TableServiceClient } from "../src/table";

type TestConfig =
  | {
      kind: "connection-string";
      connectionString: string;
    }
  | {
      kind: "service-principal";
      blobEndpoint: string;
      tableEndpoint: string;
    };

const runStorageTests = process.env.AZUREFETCH_RUN_STORAGE_TESTS === "1";
const storageConnectionString = process.env.AZUREFETCH_STORAGE_CONNECTION_STRING;
const storageAuthMode = process.env.AZUREFETCH_STORAGE_AUTH_MODE;
const storageAccountName = process.env.AZUREFETCH_STORAGE_ACCOUNT_NAME;
const storageEndpointSuffix = process.env.AZUREFETCH_STORAGE_ENDPOINT_SUFFIX || "core.windows.net";
const blobEndpointFromEnv = process.env.AZUREFETCH_STORAGE_BLOB_ENDPOINT;
const tableEndpointFromEnv = process.env.AZUREFETCH_STORAGE_TABLE_ENDPOINT;
const tenantId = process.env.AZURE_TENANT_ID;
const clientId = process.env.AZURE_CLIENT_ID;
const clientSecret = process.env.AZURE_CLIENT_SECRET;

const normalizedStorageConnectionString =
  storageConnectionString === "UseDevelopmentStorage=true"
    ? "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;"
    : storageConnectionString;

const servicePrincipalConfig: TestConfig | undefined =
  storageAccountName && tenantId && clientId && clientSecret
    ? {
        kind: "service-principal",
        blobEndpoint: blobEndpointFromEnv ?? `https://${storageAccountName}.blob.${storageEndpointSuffix}`,
        tableEndpoint: tableEndpointFromEnv ?? `https://${storageAccountName}.table.${storageEndpointSuffix}`,
      }
    : undefined;

const testConfig: TestConfig | undefined =
  storageAuthMode === "service-principal"
    ? servicePrincipalConfig
    : storageAuthMode === "connection-string"
      ? normalizedStorageConnectionString
        ? {
            kind: "connection-string",
            connectionString: normalizedStorageConnectionString,
          }
        : undefined
      : normalizedStorageConnectionString
        ? {
            kind: "connection-string",
            connectionString: normalizedStorageConnectionString,
          }
        : servicePrincipalConfig;

const shouldRunIntegration = runStorageTests && testConfig != null;

if (shouldRunIntegration) {
  describe("storage integration (manual)", () => {
    if (testConfig == null) {
      return;
    }

    const credential = new DefaultAzureCredential();
    const blobService =
      testConfig.kind === "connection-string"
        ? BlobServiceClient.fromConnectionString(testConfig.connectionString)
        : new BlobServiceClient(testConfig.blobEndpoint, credential);

    const tableService =
      testConfig.kind === "connection-string"
        ? TableServiceClient.fromConnectionString(testConfig.connectionString)
        : new TableServiceClient(testConfig.tableEndpoint, credential);

    describe("blob operations", () => {
      describe.sequential("container lifecycle", () => {
        const containerPrefix = `azfetch-blob-${randomToken()}`;
        const firstContainerName = `${containerPrefix}-1`;
        const secondContainerName = `${containerPrefix}-2`;
        const firstContainer = blobService.getContainerClient(firstContainerName);
        const secondContainer = blobService.getContainerClient(secondContainerName);

        afterAll(async () => {
          await secondContainer.deleteIfExists();
          await firstContainer.deleteIfExists();
        });

        test("createIfNotExists creates the first container", async () => {
          const response = await firstContainer.createIfNotExists();

          expect(response.succeeded).toBe(true);
        });

        test("createIfNotExists creates the second container", async () => {
          const response = await secondContainer.createIfNotExists();

          expect(response.succeeded).toBe(true);
        });

        test("listContainers paginates with maxPageSize=1", async () => {
          const listed: string[] = [];

          for await (const page of blobService.listContainers().byPage({ maxPageSize: 1 })) {
            listed.push(...page.segment.containerItems.map((item) => item.name));
          }

          expect(listed).toContain(firstContainerName);
          expect(listed).toContain(secondContainerName);
        });
      });

      describe.sequential("block blob lifecycle", () => {
        const container = blobService.getContainerClient(`azfetch-blob-${randomToken()}`);
        const blobName = "folder/hello.txt";
        const replacementBlobName = "folder/world.txt";
        const blob = container.getBlockBlobClient(blobName);
        const replacementBlob = container.getBlockBlobClient(replacementBlobName);

        beforeAll(async () => {
          const createResponse = await container.createIfNotExists();
          expect(createResponse.succeeded).toBe(true);
        });

        afterAll(async () => {
          await container.deleteIfExists();
        });

        test("upload stores the blob contents", async () => {
          const response = await blob.upload("hello", 5);

          expect(response.status).toBe(201);
        });

        test("exists returns true for an uploaded blob", async () => {
          expect(await blob.exists()).toBe(true);
        });

        test("download returns the uploaded text", async () => {
          const text = await (await blob.download(0, 5)).text();

          expect(text).toBe("hello");
        });

        test("downloadToBuffer returns the uploaded bytes", async () => {
          const downloaded = await blob.downloadToBuffer(0);

          expect(new TextDecoder().decode(downloaded)).toBe("hello");
        });

        test("getProperties returns an etag", async () => {
          const properties = await blob.getProperties();

          expect(properties.etag).toBeTruthy();
        });

        test("listBlobsFlat paginates uploaded blob names", async () => {
          await replacementBlob.upload("world", 5);

          const blobNames: string[] = [];
          for await (const page of container.listBlobsFlat().byPage({ maxPageSize: 1 })) {
            blobNames.push(...page.segment.blobItems.map((item) => item.name));
          }

          expect(blobNames).toContain(blobName);
          expect(blobNames).toContain(replacementBlobName);
        });

        test("deleteIfExists returns succeeded=true for an existing blob", async () => {
          const response = await blob.deleteIfExists();

          expect(response.succeeded).toBe(true);
        });

        test("deleteIfExists returns BlobNotFound for a missing blob", async () => {
          const response = await blob.deleteIfExists();

          expect(response).toEqual({ succeeded: false, errorCode: "BlobNotFound" });
        });
      });

      describe.sequential("container helpers", () => {
        const container = blobService.getContainerClient(`azfetch-blob-${randomToken()}-helpers`);
        const presentBlob = container.getBlockBlobClient("present.txt");
        const missingContainer = blobService.getContainerClient(`azfetch-blob-${randomToken()}-missing`);

        afterAll(async () => {
          await container.deleteIfExists();
        });

        test("deleteIfExists returns ContainerNotFound for a missing container", async () => {
          const response = await missingContainer.deleteIfExists();

          expect(response).toEqual({ succeeded: false, errorCode: "ContainerNotFound" });
        });

        test("exists returns false before the container is created", async () => {
          expect(await container.exists()).toBe(false);
        });

        test("createIfNotExists creates the helper container", async () => {
          const response = await container.createIfNotExists();

          expect(response.succeeded).toBe(true);
        });

        test("exists returns true after the container is created", async () => {
          expect(await container.exists()).toBe(true);
        });

        test("BlockBlobClient.exists returns false before upload", async () => {
          expect(await presentBlob.exists()).toBe(false);
        });

        test("container.deleteBlob removes an existing blob", async () => {
          const uploadResponse = await presentBlob.upload("persist", 7);
          expect(uploadResponse.status).toBe(201);
          expect(await presentBlob.exists()).toBe(true);

          await container.deleteBlob("present.txt");

          expect(await presentBlob.exists()).toBe(false);
        });

        test("container.deleteBlob ignores a missing blob", async () => {
          await container.deleteBlob("present.txt");

          expect(await presentBlob.exists()).toBe(false);
        });
      });

      test("generateAccountSasUrl includes the requested permissions and services", () => {
        const sasUrl = blobService.generateAccountSasUrl(new Date("2026-01-01T00:00:00.000Z"), {
          permissions: "rwl",
          services: "bf",
          resourceTypes: "sco",
          protocol: "http",
        });
        const parsed = new URL(sasUrl);

        expect(parsed.searchParams.get("sp")).toBe("rwl");
        expect(parsed.searchParams.get("ss")).toBe("bf");
        expect(parsed.searchParams.get("srt")).toBe("sco");
        expect(parsed.searchParams.get("spr")).toBe("http");
        expect(parsed.searchParams.get("se")).toBe("2026-01-01T00:00:00.000Z");
        expect(parsed.searchParams.get("sv")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      describe.sequential("blob batch", () => {
        const batchContainer = blobService.getContainerClient(`azfetch-blob-${randomToken()}-batch`);
        const firstBlob = batchContainer.getBlockBlobClient("delete-1.txt");
        const secondBlob = batchContainer.getBlockBlobClient("delete-2.txt");
        const batchClient = blobService.getBlobBatchClient();
        const expectedRequestUris = [new URL(firstBlob.url).pathname, new URL(secondBlob.url).pathname];

        beforeAll(async () => {
          await batchContainer.createIfNotExists();
          await firstBlob.upload("first", 5);
          await secondBlob.upload("second", 6);
        });

        afterAll(async () => {
          await batchContainer.deleteIfExists();
        });

        test("getBlobBatchClient is available from the service and container", () => {
          expect(blobService.getBlobBatchClient()).toBeDefined();
          expect(batchContainer.getBlobBatchClient()).toBeDefined();
        });

        test("submitBatch deletes both blobs", async () => {
          const batch = batchClient.createBatch();
          await batch.deleteBlob(firstBlob.url, undefined);
          await batch.deleteBlob(secondBlob.url, undefined);

          const response = await batchClient.submitBatch(batch);

          expect(response.status).toBe(202);
          expect(response.subResponses).toHaveLength(2);
          expect(response.subResponsesSucceededCount).toBe(2);
          expect(response.subResponsesFailedCount).toBe(0);

          for (const responsePart of response.subResponses) {
            expect(responsePart?.status).toBe(202);
            expect(responsePart?._request?.method).toBe("DELETE");
            expect(responsePart?._request?.uri).toBeDefined();
            expect(expectedRequestUris).toContain(responsePart?._request?.uri);
          }
        });
      });
    });

    describe("table operations", () => {
      describe.sequential("table lifecycle", () => {
        const tableName = createTableName("lifecycle");
        const tableClient = tableService.getTableClient(tableName);

        afterAll(async () => {
          await tableService.deleteTableIfExists(tableName);
        });

        test("createTableIfNotExists creates a new table", async () => {
          const response = await tableService.createTableIfNotExists(tableName);

          expect(response.succeeded).toBe(true);
        });

        test("TableClient.createIfNotExists returns TableAlreadyExists for an existing table", async () => {
          const response = await tableClient.createIfNotExists();

          expect(response.succeeded).toBe(false);
          expect(response.errorCode).toBe("TableAlreadyExists");
        });

        test("TableClient.deleteIfExists returns succeeded=true for an existing table", async () => {
          const response = await tableClient.deleteIfExists();

          expect(response).toEqual({ succeeded: true });
        });

        test("deleteTableIfExists returns TableNotFound for a missing table", async () => {
          const response = await tableService.deleteTableIfExists(tableName);

          expect(response).toEqual({ succeeded: false, errorCode: "TableNotFound" });
        });
      });

      describe.sequential("listEntities alias", () => {
        const tableName = createTableName("alias");
        const tableClient = tableService.getTableClient(tableName);
        const rowsForCleanup: Array<{ partitionKey: string; rowKey: string }> = [];

        beforeAll(async () => {
          const response = await tableService.createTableIfNotExists(tableName);
          expect(response.succeeded).toBe(true);
        });

        afterAll(async () => {
          await deleteTableRowsInTransaction(tableClient, rowsForCleanup);
          await tableService.deleteTableIfExists(tableName);
        });

        test("upsertEntity writes the first aliased row", async () => {
          await tableClient.upsertEntity({
            partitionKey: "partition",
            rowKey: "row-a",
            value: "first",
          });
          rowsForCleanup.push({ partitionKey: "partition", rowKey: "row-a" });
        });

        test("upsertEntity writes the second aliased row", async () => {
          await tableClient.upsertEntity({
            partitionKey: "partition",
            rowKey: "row-b",
            value: "second",
          });
          rowsForCleanup.push({ partitionKey: "partition", rowKey: "row-b" });
        });

        test("listEntities paginates with continuation tokens", async () => {
          const rowKeys: string[] = [];
          const continuationTokens: Array<string | undefined> = [];

          for await (const page of tableClient.listEntities().byPage({ maxPageSize: 1 })) {
            rowKeys.push(...page.value.map((entity) => entity.rowKey));
            continuationTokens.push(page.continuationToken);
          }

          expect(rowKeys).toHaveLength(2);
          expect(continuationTokens[0]).toBeTruthy();
          expect(continuationTokens[continuationTokens.length - 1]).toBeUndefined();
        });
      });

      describe.sequential("entity lifecycle", () => {
        const tableName = createTableName("entities");
        const tableClient = tableService.getTableClient(tableName);
        const rowsForCleanup: Array<{ partitionKey: string; rowKey: string }> = [];

        beforeAll(async () => {
          const response = await tableService.createTableIfNotExists(tableName);
          expect(response.succeeded).toBe(true);
        });

        afterAll(async () => {
          await deleteTableRowsInTransaction(tableClient, rowsForCleanup);
          await tableService.deleteTableIfExists(tableName);
        });

        test("upsertEntity writes the first entity", async () => {
          await tableClient.upsertEntity({
            partitionKey: "partition",
            rowKey: "row-a",
            value: "first",
          });
          rowsForCleanup.push({ partitionKey: "partition", rowKey: "row-a" });
        });

        test("upsertEntity writes the second entity", async () => {
          await tableClient.upsertEntity({
            partitionKey: "partition",
            rowKey: "row-b",
            value: "second",
          });
          rowsForCleanup.push({ partitionKey: "partition", rowKey: "row-b" });
        });

        test("getEntity returns the written entity", async () => {
          const entity = await tableClient.getEntity("partition", "row-a");

          expect(entity).toMatchObject({
            partitionKey: "partition",
            rowKey: "row-a",
            value: "first",
          });
        });

        test("list().byPage paginates with continuation tokens", async () => {
          const rowKeys: string[] = [];
          const continuationTokens: Array<string | undefined> = [];

          for await (const page of tableClient.list().byPage({ maxPageSize: 1 })) {
            rowKeys.push(...page.value.map((entity) => entity.rowKey));
            continuationTokens.push(page.continuationToken);
          }

          expect(rowKeys).toHaveLength(2);
          expect(continuationTokens[0]).toBeTruthy();
          expect(continuationTokens[continuationTokens.length - 1]).toBeUndefined();
        });

        test("getEntity returns undefined for a missing row", async () => {
          const missing = await tableClient.getEntity("missing", "row");

          expect(missing).toBeUndefined();
        });

        test("deleteEntity returns succeeded=true for an existing row", async () => {
          const response = await tableClient.deleteEntity("partition", "row-a");

          expect(response.succeeded).toBe(true);

          const deletedRowIndex = rowsForCleanup.findIndex((row) => row.rowKey === "row-a");
          if (deletedRowIndex >= 0) {
            rowsForCleanup.splice(deletedRowIndex, 1);
          }
        });

        test("deleteEntity returns ResourceNotFound for a missing row", async () => {
          const response = await tableClient.deleteEntity("partition", "row-a");

          expect(response).toEqual({ succeeded: false, errorCode: "ResourceNotFound" });
        });
      });

      describe.sequential("table batch", () => {
        const tableName = createTableName("batch");
        const tableClient = tableService.getTableClient(tableName);
        const rowsForCleanup: Array<{ partitionKey: string; rowKey: string }> = [];
        const batchedRows = [
          { partitionKey: "batch-partition", rowKey: "row-a", value: "first" },
          { partitionKey: "batch-partition", rowKey: "row-b", value: "second" },
        ] as const;

        beforeAll(async () => {
          const response = await tableService.createTableIfNotExists(tableName);
          expect(response.succeeded).toBe(true);
        });

        afterAll(async () => {
          await deleteTableRowsInTransaction(tableClient, rowsForCleanup);
          await tableService.deleteTableIfExists(tableName);
        });

        test("submitTransaction creates multiple rows", async () => {
          const response = await tableClient.submitTransaction(
            batchedRows.map((row) => ({
              action: "create" as const,
              entity: row,
            })),
          );

          rowsForCleanup.push(
            ...batchedRows.map((row) => ({
              partitionKey: row.partitionKey,
              rowKey: row.rowKey,
            })),
          );

          expect(response.status).toBe(202);
          expect(response.subResponses).toHaveLength(2);
          for (const subResponse of response.subResponses) {
            expect([201, 204]).toContain(subResponse.status);
          }

          const firstRow = await tableClient.getEntity(batchedRows[0].partitionKey, batchedRows[0].rowKey);
          const secondRow = await tableClient.getEntity(batchedRows[1].partitionKey, batchedRows[1].rowKey);

          expect(firstRow).toMatchObject(batchedRows[0]);
          expect(secondRow).toMatchObject(batchedRows[1]);
        });

        test("submitTransaction deletes multiple rows", async () => {
          const response = await tableClient.submitTransaction(
            batchedRows.map((row) => ({
              action: "delete" as const,
              partitionKey: row.partitionKey,
              rowKey: row.rowKey,
            })),
          );

          expect(response.status).toBe(202);
          expect(response.subResponses).toHaveLength(2);
          for (const subResponse of response.subResponses) {
            expect([202, 204]).toContain(subResponse.status);
          }

          rowsForCleanup.length = 0;
          await expect(
            tableClient.getEntity(batchedRows[0].partitionKey, batchedRows[0].rowKey),
          ).resolves.toBeUndefined();
          await expect(
            tableClient.getEntity(batchedRows[1].partitionKey, batchedRows[1].rowKey),
          ).resolves.toBeUndefined();
        });
      });
    });
  });
} else {
  describe.skip("storage integration (manual)", () => {
    test("is skipped without storage runtime config", () => {});
  });
}

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTableName(suffix: string): string {
  return `azfetchtable${randomToken().replace(/-/g, "")}${suffix}`.slice(0, 63);
}

async function deleteTableRowsInTransaction(
  tableClient: ReturnType<TableServiceClient["getTableClient"]>,
  rows: Array<{ partitionKey: string; rowKey: string }>,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const response = await tableClient.submitTransaction(
    rows.map((row) => ({
      action: "delete",
      partitionKey: row.partitionKey,
      rowKey: row.rowKey,
    })),
  );

  expect(response.status).toBe(202);
  expect(response.subResponses).toHaveLength(rows.length);
  for (const rowResponse of response.subResponses) {
    expect([204, 202]).toContain(rowResponse?.status);
  }
}
