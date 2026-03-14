import { BlobServiceClient, DefaultAzureCredential, TableClient, TableServiceClient } from "../../src";

import type { BlobBenchmarkService, StorageBenchmarkDriver, TableBenchmarkService, TestConfig } from "../types";

function isSucceededCreateResponse(response: { succeeded: boolean }): boolean {
  return response.succeeded;
}

async function collectContainerNames(blobService: BlobServiceClient): Promise<string[]> {
  const names: string[] = [];

  for await (const page of blobService.listContainers().byPage()) {
    names.push(...page.segment.containerItems.map((container) => container.name));
  }

  return names;
}

async function collectBlobNames(containerName: string, blobService: BlobServiceClient): Promise<string[]> {
  const container = blobService.getContainerClient(containerName);
  const names: string[] = [];

  for await (const page of container.listBlobsFlat().byPage()) {
    names.push(...page.segment.blobItems.map((blob) => blob.name));
  }

  return names;
}

async function collectRowKeys(tableClient: TableClient): Promise<string[]> {
  const rows: string[] = [];

  for await (const page of tableClient.list().byPage()) {
    rows.push(...page.value.map((entity) => String(entity.rowKey)));
  }

  return rows;
}

function createBlobService(config: TestConfig): BlobBenchmarkService {
  const credential = config.kind === "service-principal" ? new DefaultAzureCredential() : undefined;
  const blobService =
    config.kind === "connection-string"
      ? BlobServiceClient.fromConnectionString(config.connectionString)
      : new BlobServiceClient(config.blobEndpoint, credential);

  return {
    async createContainer(containerName) {
      const container = blobService.getContainerClient(containerName);
      const response = await container.createIfNotExists();

      return {
        succeeded: isSucceededCreateResponse(response),
      };
    },

    async uploadBlob(containerName, blobName, payload) {
      const container = blobService.getContainerClient(containerName);
      const blob = container.getBlockBlobClient(blobName);
      await blob.upload(payload, payload.length);
    },

    async downloadBlob(containerName, blobName, length) {
      const container = blobService.getContainerClient(containerName);
      const blob = container.getBlockBlobClient(blobName);
      const response = await blob.download(0, length);
      return response.text();
    },

    async listContainerNames() {
      return collectContainerNames(blobService);
    },

    async listBlobNames(containerName) {
      return collectBlobNames(containerName, blobService);
    },

    async deleteBlob(containerName, blobName) {
      const container = blobService.getContainerClient(containerName);
      const blob = container.getBlockBlobClient(blobName);
      return blob.deleteIfExists();
    },

    async deleteContainer(containerName) {
      const container = blobService.getContainerClient(containerName);
      const response = await container.deleteIfExists();
      return {
        succeeded: response.succeeded,
        errorCode: response.errorCode,
      };
    },

    async uploadBatchBlobs(containerName, blobNames, payload) {
      const container = blobService.getContainerClient(containerName);
      const blobs = blobNames.map((name) => container.getBlockBlobClient(name));
      await Promise.all(blobs.map((blob) => blob.upload(payload, payload.length)));
    },

    async deleteBlobBatch(containerName, blobNames) {
      const container = blobService.getContainerClient(containerName);
      const blobs = blobNames.map((name) => container.getBlockBlobClient(name));
      const batchClient = container.getBlobBatchClient();

      const batch = batchClient.createBatch();
      for (const blob of blobs) {
        await batch.deleteBlob(blob.url, undefined);
      }

      const response = await batchClient.submitBatch(batch);
      return {
        status: response.status,
        succeededCount: response.subResponsesSucceededCount,
        failedCount: response.subResponsesFailedCount,
      };
    },
  };
}

function createTableService(config: TestConfig): TableBenchmarkService {
  const credential = config.kind === "service-principal" ? new DefaultAzureCredential() : undefined;
  const tableService =
    config.kind === "connection-string"
      ? TableServiceClient.fromConnectionString(config.connectionString)
      : new TableServiceClient(config.tableEndpoint, credential);

  return {
    async createTable(tableName) {
      const response = await tableService.createTableIfNotExists(tableName);
      return {
        succeeded: response.succeeded,
        errorCode: response.errorCode,
      };
    },

    async upsertEntity(tableName, partitionKey, rowKey, payload) {
      const tableClient = tableService.getTableClient(tableName);
      await tableClient.upsertEntity({
        partitionKey,
        rowKey,
        value: payload,
      });
    },

    async getEntityValue(tableName, partitionKey, rowKey) {
      const tableClient = tableService.getTableClient(tableName);
      const entity = await tableClient.getEntity(partitionKey, rowKey);

      if (entity == null) {
        return undefined;
      }

      if (typeof entity.value === "string") {
        return entity.value;
      }

      if (entity.value == null) {
        return undefined;
      }

      throw new Error(`unexpected entity payload type: ${typeof entity.value}`);
    },

    async listRowKeys(tableName) {
      const tableClient = tableService.getTableClient(tableName);
      return collectRowKeys(tableClient);
    },

    async deleteEntity(tableName, partitionKey, rowKey) {
      const tableClient = tableService.getTableClient(tableName);
      return tableClient.deleteEntity(partitionKey, rowKey);
    },

    async deleteTable(tableName) {
      const response = await tableService.deleteTableIfExists(tableName);

      return {
        succeeded: response.succeeded,
        errorCode: response.errorCode,
      };
    },
  };
}

export const nativeBenchmarkDriver: StorageBenchmarkDriver = {
  id: "native",
  displayName: "azurefetch",
  createBlobService(config) {
    return Promise.resolve(createBlobService(config));
  },
  createTableService(config) {
    return Promise.resolve(createTableService(config));
  },
};
