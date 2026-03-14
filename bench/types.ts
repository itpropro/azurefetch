export type BenchmarkDriverId = "native" | "sdk";

export type TestConfig =
  | {
      kind: "connection-string";
      connectionString: string;
    }
  | {
      kind: "service-principal";
      blobEndpoint: string;
      tableEndpoint: string;
    };

export type BenchmarkStats = Map<string, number[]>;

export interface BenchmarkMode {
  testConfig: TestConfig;
  iterations: number;
  warmup: number;
  batchSize: number;
}

export interface BenchmarkOperationResult {
  succeeded: boolean;
  errorCode?: string;
}

export interface BlobBatchDeleteResult {
  status: number;
  succeededCount: number;
  failedCount: number;
}

export interface BlobBenchmarkService {
  createContainer(containerName: string): Promise<BenchmarkOperationResult>;
  uploadBlob(containerName: string, blobName: string, payload: string): Promise<void>;
  downloadBlob(containerName: string, blobName: string, length: number): Promise<string>;
  listContainerNames(): Promise<string[]>;
  listBlobNames(containerName: string): Promise<string[]>;
  deleteBlob(containerName: string, blobName: string): Promise<BenchmarkOperationResult>;
  deleteContainer(containerName: string): Promise<BenchmarkOperationResult>;
  uploadBatchBlobs(containerName: string, blobNames: string[], payload: string): Promise<void>;
  deleteBlobBatch(containerName: string, blobNames: string[]): Promise<BlobBatchDeleteResult>;
}

export interface TableBenchmarkService {
  createTable(tableName: string): Promise<BenchmarkOperationResult>;
  upsertEntity(tableName: string, partitionKey: string, rowKey: string, payload: string): Promise<void>;
  getEntityValue(tableName: string, partitionKey: string, rowKey: string): Promise<string | undefined>;
  listRowKeys(tableName: string): Promise<string[]>;
  deleteEntity(tableName: string, partitionKey: string, rowKey: string): Promise<BenchmarkOperationResult>;
  deleteTable(tableName: string): Promise<BenchmarkOperationResult>;
}

export interface StorageBenchmarkDriver {
  readonly id: BenchmarkDriverId;
  readonly displayName: string;

  createBlobService(testConfig: TestConfig): Promise<BlobBenchmarkService>;
  createTableService(testConfig: TestConfig): Promise<TableBenchmarkService>;
}
