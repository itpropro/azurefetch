import { describe, expect, test } from "vitest";

import { BlobServiceClient, DefaultAzureCredential, TableServiceClient } from "../src";

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

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

if (shouldRunIntegration) {
  describe("storage integration (manual)", () => {
    if (testConfig == null) {
      return;
    }

    const blobToken = randomToken();
    const tableToken = randomToken();

    const credential = new DefaultAzureCredential();
    const blobService =
      testConfig.kind === "connection-string"
        ? BlobServiceClient.fromConnectionString(testConfig.connectionString)
        : new BlobServiceClient(testConfig.blobEndpoint, credential);

    const tableService =
      testConfig.kind === "connection-string"
        ? TableServiceClient.fromConnectionString(testConfig.connectionString)
        : new TableServiceClient(testConfig.tableEndpoint, credential);

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

    describe("blob operations", () => {
      test("creates containers and validates list pagination", async () => {
        const containerPrefix = `azfetch-blob-${blobToken}`;
        const firstContainerName = `${containerPrefix}-1`;
        const secondContainerName = `${containerPrefix}-2`;
        const firstContainer = blobService.getContainerClient(firstContainerName);
        const secondContainer = blobService.getContainerClient(secondContainerName);

        try {
          const createFirst = await firstContainer.createIfNotExists();
          expect(createFirst.succeeded).toBe(true);

          const createSecond = await secondContainer.createIfNotExists();
          expect(createSecond.succeeded).toBe(true);

          const listed = [] as string[];
          for await (const page of blobService.listContainers().byPage({ maxPageSize: 1 })) {
            listed.push(...page.segment.containerItems.map((item) => item.name));
          }

          expect(listed).toContain(firstContainerName);
          expect(listed).toContain(secondContainerName);
        } finally {
          await secondContainer.deleteIfExists();
          await firstContainer.deleteIfExists();
        }
      });

      test("manages blob lifecycle and continuation", async () => {
        const container = blobService.getContainerClient(`azfetch-blob-${blobToken}-${randomToken()}`);
        const blobName = "folder/hello.txt";
        const replacementBlobName = "folder/world.txt";
        const blob = container.getBlockBlobClient(blobName);
        const replacementBlob = container.getBlockBlobClient(replacementBlobName);

        try {
          const createResponse = await container.createIfNotExists();
          expect(createResponse.succeeded).toBe(true);

          const uploadResponse = await blob.upload("hello", 5);
          expect(uploadResponse.status).toBe(201);

          expect(await blob.exists()).toBe(true);

          const downloadText = await (await blob.download(0, 5)).text();
          expect(downloadText).toBe("hello");

          const downloaded = await blob.downloadToBuffer(0);
          expect(new TextDecoder().decode(downloaded)).toBe("hello");

          const properties = await blob.getProperties();
          expect(properties.etag).toBeTruthy();

          await replacementBlob.upload("world", 5);

          const blobNames = [] as string[];
          for await (const page of container.listBlobsFlat().byPage({ maxPageSize: 1 })) {
            blobNames.push(...page.segment.blobItems.map((item) => item.name));
          }

          expect(blobNames).toContain(blobName);
          expect(blobNames).toContain(replacementBlobName);

          const deleteResponse = await blob.deleteIfExists();
          expect(deleteResponse.succeeded).toBe(true);

          const missingDelete = await blob.deleteIfExists();
          expect(missingDelete).toEqual({ succeeded: false, errorCode: "BlobNotFound" });
        } finally {
          await container.deleteIfExists();
        }
      });

      test("covers container exists and blob deletion helpers", async () => {
        const containerName = `azfetch-blob-${blobToken}-${randomToken()}-helpers`;
        const container = blobService.getContainerClient(containerName);
        const presentBlob = container.getBlockBlobClient("present.txt");

        const missingContainer = blobService.getContainerClient(`azfetch-blob-${blobToken}-${randomToken()}-missing`);

        try {
          const missingContainerDelete = await missingContainer.deleteIfExists();
          expect(missingContainerDelete).toEqual({ succeeded: false, errorCode: "ContainerNotFound" });

          expect(await container.exists()).toBe(false);

          const createResponse = await container.createIfNotExists();
          expect(createResponse.succeeded).toBe(true);

          expect(await container.exists()).toBe(true);

          expect(await presentBlob.exists()).toBe(false);

          const uploadResponse = await presentBlob.upload("persist", 7);
          expect(uploadResponse.status).toBe(201);
          expect(await presentBlob.exists()).toBe(true);

          await container.deleteBlob("present.txt");
          expect(await presentBlob.exists()).toBe(false);

          await container.deleteBlob("present.txt");
          expect(await presentBlob.exists()).toBe(false);
        } finally {
          await container.deleteIfExists();
        }
      });

      test("builds account SAS URLs", () => {
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

      test("submits blob batch delete operations", async () => {
        const batchContainer = blobService.getContainerClient(`azfetch-blob-${blobToken}-${randomToken()}-batch`);
        const firstBlob = batchContainer.getBlockBlobClient("delete-1.txt");
        const secondBlob = batchContainer.getBlockBlobClient("delete-2.txt");
        const batchClient = blobService.getBlobBatchClient();
        const expectedRequestUris = [new URL(firstBlob.url).pathname, new URL(secondBlob.url).pathname];

        try {
          expect(blobService.getBlobBatchClient()).toBeDefined();
          expect(batchContainer.getBlobBatchClient()).toBeDefined();

          await batchContainer.createIfNotExists();

          await firstBlob.upload("first", 5);
          await secondBlob.upload("second", 6);

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
        } finally {
          await batchContainer.deleteIfExists();
        }
      });
    });

    describe("table operations", () => {
      test("creates and deletes tables with idempotent semantics", async () => {
        const tableName = `azfetchtable${tableToken.replace(/-/g, "")}`;
        const tableClient = tableService.getTableClient(tableName);

        try {
          const createResponse = await tableService.createTableIfNotExists(tableName);
          expect(createResponse.succeeded).toBe(true);

          const createViaClient = await tableClient.createIfNotExists();
          expect(createViaClient.succeeded).toBe(false);
          expect(createViaClient.errorCode).toBe("TableAlreadyExists");

          const deleteViaClient = await tableClient.deleteIfExists();
          expect(deleteViaClient).toEqual({ succeeded: true });

          const deleteViaClientAgain = await tableClient.deleteIfExists();
          expect(deleteViaClientAgain).toEqual({
            succeeded: false,
            errorCode: "TableNotFound",
          });
        } finally {
          await tableService.deleteTableIfExists(tableName);
        }
      });

      test("supports table client listEntities alias", async () => {
        const tableName = `azfetchtable${tableToken.replace(/-/g, "").slice(0, 24)}alias`;
        const tableClient = tableService.getTableClient(`${tableName}entities`);
        const rowsForCleanup: Array<{ partitionKey: string; rowKey: string }> = [];

        try {
          const createResponse = await tableService.createTableIfNotExists(`${tableName}entities`);
          expect(createResponse.succeeded).toBe(true);

          await tableClient.upsertEntity({
            partitionKey: "partition",
            rowKey: "row-a",
            value: "first",
          });
          rowsForCleanup.push({
            partitionKey: "partition",
            rowKey: "row-a",
          });

          await tableClient.upsertEntity({
            partitionKey: "partition",
            rowKey: "row-b",
            value: "second",
          });
          rowsForCleanup.push({
            partitionKey: "partition",
            rowKey: "row-b",
          });

          const rowKeys = [] as string[];
          const continuationTokens: Array<string | undefined> = [];

          for await (const page of tableClient.listEntities().byPage({ maxPageSize: 1 })) {
            rowKeys.push(...page.value.map((entity) => entity.rowKey));
            continuationTokens.push(page.continuationToken);
          }

          expect(rowKeys).toHaveLength(2);
          expect(continuationTokens[0]).toBeTruthy();
          expect(continuationTokens[continuationTokens.length - 1]).toBeUndefined();
        } finally {
          await deleteTableRowsInTransaction(tableClient, rowsForCleanup);
          await tableService.deleteTableIfExists(`${tableName}entities`);
        }
      });

      test("supports table deletion idempotency at service level", async () => {
        const tableName = `azfetchtable${tableToken.replace(/-/g, "").slice(0, 24)}delete`;
        const tableClient = tableService.getTableClient(tableName);

        const createResponse = await tableService.createTableIfNotExists(tableName);
        expect(createResponse.succeeded).toBe(true);

        const deleteResponse = await tableClient.deleteIfExists();
        expect(deleteResponse).toEqual({ succeeded: true });

        const deleteMissing = await tableService.deleteTableIfExists(tableName);
        expect(deleteMissing).toEqual({ succeeded: false, errorCode: "TableNotFound" });
      });

      test("supports entity CRUD and paging", async () => {
        const tableName = `azfetchtable${tableToken.replace(/-/g, "").slice(0, 30)}`;
        const tableClient = tableService.getTableClient(`${tableName}entities`);
        const rowsForCleanup: Array<{ partitionKey: string; rowKey: string }> = [];

        try {
          const createResponse = await tableService.createTableIfNotExists(`${tableName}entities`);
          expect(createResponse.succeeded).toBe(true);

          await tableClient.upsertEntity({
            partitionKey: "partition",
            rowKey: "row-a",
            value: "first",
          });
          rowsForCleanup.push({
            partitionKey: "partition",
            rowKey: "row-a",
          });

          await tableClient.upsertEntity({
            partitionKey: "partition",
            rowKey: "row-b",
            value: "second",
          });
          rowsForCleanup.push({
            partitionKey: "partition",
            rowKey: "row-b",
          });

          const entity = await tableClient.getEntity("partition", "row-a");
          expect(entity).toMatchObject({
            partitionKey: "partition",
            rowKey: "row-a",
            value: "first",
          });

          const pageValues = [] as string[];
          const continuationTokens: Array<string | undefined> = [];
          for await (const page of tableClient.list().byPage({ maxPageSize: 1 })) {
            pageValues.push(...page.value.map((entity) => entity.rowKey));
            continuationTokens.push(page.continuationToken);
          }

          expect(pageValues).toHaveLength(2);
          expect(continuationTokens[0]).toBeTruthy();
          expect(continuationTokens[continuationTokens.length - 1]).toBeUndefined();

          const missing = await tableClient.getEntity("missing", "row");
          expect(missing).toBeUndefined();

          const deleteExisting = await tableClient.deleteEntity("partition", "row-a");
          expect(deleteExisting.succeeded).toBe(true);

          const deletedRowIndex = rowsForCleanup.findIndex((row) => row.rowKey === "row-a");
          if (deletedRowIndex >= 0) {
            rowsForCleanup.splice(deletedRowIndex, 1);
          }

          const deleteMissing = await tableClient.deleteEntity("partition", "row-a");
          expect(deleteMissing).toEqual({ succeeded: false, errorCode: "ResourceNotFound" });
        } finally {
          await deleteTableRowsInTransaction(tableClient, rowsForCleanup);
          await tableService.deleteTableIfExists(`${tableName}entities`);
        }
      });
    });
  });
} else {
  describe.skip("storage integration (manual)", () => {
    test("is skipped without storage runtime config", () => {});
  });
}
