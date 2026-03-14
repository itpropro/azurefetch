import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { TableClient } from "@azure/data-tables";

import type { BlobBenchmarkService, StorageBenchmarkDriver, TableBenchmarkService, TestConfig } from "../types";

function parseStatusCode(error: unknown): number | undefined {
  if (error != null && typeof error === "object" && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") {
      return statusCode;
    }
  }

  return undefined;
}

function isTableAlreadyExistsError(error: unknown): boolean {
  if (error != null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return code === "TableAlreadyExists";
  }

  return parseStatusCode(error) === 409;
}

function isTableMissingError(error: unknown): boolean {
  if (error != null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return code === "ResourceNotFound" || code === "TableNotFound" || code === "EntityNotFound";
  }

  return parseStatusCode(error) === 404;
}

async function collectContainerNames(blobService: BlobServiceClient): Promise<string[]> {
  const names: string[] = [];

  for await (const page of blobService.listContainers().byPage()) {
    names.push(...page.containerItems.map((container) => container.name));
  }

  return names;
}

async function collectBlobNames(blobService: BlobServiceClient, containerName: string): Promise<string[]> {
  const container = blobService.getContainerClient(containerName);
  const names: string[] = [];

  for await (const page of container.listBlobsFlat().byPage()) {
    names.push(...page.segment.blobItems.map((blob) => blob.name));
  }

  return names;
}

function collectRowKeys(tableClient: TableClient): Promise<string[]> {
  return (async () => {
    const rows: string[] = [];

    for await (const page of tableClient.listEntities().byPage()) {
      const directItems = page.value;
      const segmentItems = page["segment"]?.value;
      const indexedItems = Object.entries(page)
        .filter(([key]) => key !== "continuationToken")
        .map(([, value]) => value)
        .filter((value): value is { rowKey: unknown } => {
          return value != null && typeof value === "object" && "rowKey" in value;
        });

      const items = Array.isArray(directItems)
        ? directItems
        : Array.isArray(segmentItems)
          ? segmentItems
          : indexedItems;
      rows.push(...items.map((entity) => String(entity.rowKey)));
    }

    return rows;
  })();
}

function createTableClient(config: TestConfig, tableName: string): TableClient {
  return config.kind === "connection-string"
    ? TableClient.fromConnectionString(config.connectionString, tableName)
    : new TableClient(config.tableEndpoint, tableName, new DefaultAzureCredential());
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
        succeeded: response.succeeded,
        errorCode: response.errorCode,
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
      const response = await blob.downloadToBuffer(0, length);
      return response.toString("utf8");
    },

    async listContainerNames() {
      return collectContainerNames(blobService);
    },

    async listBlobNames(containerName) {
      return collectBlobNames(blobService, containerName);
    },

    async deleteBlob(containerName, blobName) {
      const container = blobService.getContainerClient(containerName);
      const blob = container.getBlockBlobClient(blobName);
      try {
        const response = await blob.deleteIfExists();

        return {
          succeeded: response.succeeded,
          errorCode: response.errorCode,
        };
      } catch (error: unknown) {
        if (isTableMissingError(error)) {
          return {
            succeeded: false,
            errorCode: "BlobNotFound",
          };
        }

        throw error;
      }
    },

    async deleteContainer(containerName) {
      const container = blobService.getContainerClient(containerName);
      try {
        const response = await container.deleteIfExists();
        return {
          succeeded: response.succeeded,
          errorCode: response.errorCode,
        };
      } catch (error) {
        if (isTableMissingError(error)) {
          return {
            succeeded: false,
            errorCode: "ContainerNotFound",
          };
        }

        throw error;
      }
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
      const response = await batchClient.deleteBlobs(blobs, undefined);

      return {
        status: response.status,
        succeededCount: response.subResponsesSucceededCount,
        failedCount: response.subResponsesFailedCount,
      };
    },
  };
}

function createTableService(config: TestConfig): TableBenchmarkService {
  return {
    async createTable(tableName) {
      const tableClient = createTableClient(config, tableName);
      try {
        await tableClient.createTable();
        return {
          succeeded: true,
        };
      } catch (error: unknown) {
        if (isTableAlreadyExistsError(error)) {
          return {
            succeeded: false,
            errorCode: "TableAlreadyExists",
          };
        }

        throw error;
      }
    },

    async upsertEntity(tableName, partitionKey, rowKey, payload) {
      const tableClient = createTableClient(config, tableName);
      await tableClient.upsertEntity({
        partitionKey,
        rowKey,
        value: payload,
      });
    },

    async getEntityValue(tableName, partitionKey, rowKey) {
      const tableClient = createTableClient(config, tableName);

      try {
        const entity = await tableClient.getEntity(partitionKey, rowKey);
        return typeof entity.value === "string" ? entity.value : undefined;
      } catch (error: unknown) {
        if (isTableMissingError(error)) {
          return undefined;
        }

        throw error;
      }
    },

    async listRowKeys(tableName) {
      const tableClient = createTableClient(config, tableName);

      return collectRowKeys(tableClient);
    },

    async deleteEntity(tableName, partitionKey, rowKey) {
      const tableClient = createTableClient(config, tableName);

      try {
        await tableClient.deleteEntity(partitionKey, rowKey);
        return {
          succeeded: true,
        };
      } catch (error: unknown) {
        if (isTableMissingError(error)) {
          return {
            succeeded: false,
            errorCode: "ResourceNotFound",
          };
        }

        throw error;
      }
    },

    async deleteTable(tableName) {
      const tableClient = createTableClient(config, tableName);
      try {
        await tableClient.deleteTable();
        return {
          succeeded: true,
        };
      } catch (error: unknown) {
        if (isTableMissingError(error)) {
          return {
            succeeded: false,
            errorCode: "TableNotFound",
          };
        }

        throw error;
      }
    },
  };
}

export const sdkBenchmarkDriver: StorageBenchmarkDriver = {
  id: "sdk",
  displayName: "sdk",
  createBlobService(config) {
    return Promise.resolve(createBlobService(config));
  },
  createTableService(config) {
    return Promise.resolve(createTableService(config));
  },
};
