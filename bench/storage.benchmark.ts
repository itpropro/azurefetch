import { BlobServiceClient, DefaultAzureCredential, TableClient, TableServiceClient } from "../src";

const requiredEnvVar = "AZUREFETCH_RUN_STORAGE_BENCHMARK";
const runBenchmark = process.env[requiredEnvVar] === "1";

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

type BenchmarkStats = Map<string, number[]>;

type BenchmarkMode = {
  testConfig: TestConfig;
  iterations: number;
  warmup: number;
};

const storageConnectionString = process.env.AZUREFETCH_STORAGE_CONNECTION_STRING;
const storageAuthMode = process.env.AZUREFETCH_STORAGE_AUTH_MODE;
const storageAccountName = process.env.AZUREFETCH_STORAGE_ACCOUNT_NAME;
const storageEndpointSuffix = process.env.AZUREFETCH_STORAGE_ENDPOINT_SUFFIX || "core.windows.net";
const tenantId = process.env.AZURE_TENANT_ID;
const clientId = process.env.AZURE_CLIENT_ID;
const clientSecret = process.env.AZURE_CLIENT_SECRET;
const blobEndpointFromEnv = process.env.AZUREFETCH_STORAGE_BLOB_ENDPOINT;
const tableEndpointFromEnv = process.env.AZUREFETCH_STORAGE_TABLE_ENDPOINT;
const iterations = Number.parseInt(process.env.AZUREFETCH_BENCHMARK_ITERATIONS || "5", 10);
const warmup = Number.parseInt(process.env.AZUREFETCH_BENCHMARK_WARMUP || "1", 10);

function parseConfig(): TestConfig | undefined {
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

  if (storageAuthMode === "service-principal") {
    return servicePrincipalConfig;
  }

  if (storageAuthMode === "connection-string" && normalizedStorageConnectionString != null) {
    return {
      kind: "connection-string",
      connectionString: normalizedStorageConnectionString,
    };
  }

  if (normalizedStorageConnectionString != null && normalizedStorageConnectionString.length > 0) {
    return {
      kind: "connection-string",
      connectionString: normalizedStorageConnectionString,
    };
  }

  return servicePrincipalConfig;
}

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function toPercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }

  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile));
  return sorted[index] ?? 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitUntil(predicate: () => Promise<boolean>, attempts: number, delayMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) {
      return true;
    }

    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }

  return false;
}

async function measure<T>(stats: BenchmarkStats, label: string, fn: () => Promise<T>, shouldRecord = true): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  if (!shouldRecord) {
    return result;
  }

  const samples = stats.get(label);
  if (samples == null) {
    stats.set(label, [elapsed]);
  } else {
    samples.push(elapsed);
  }

  return result;
}

async function listContainerNames(blobService: BlobServiceClient): Promise<string[]> {
  const names: string[] = [];
  for await (const page of blobService.listContainers().byPage({ maxPageSize: 100 })) {
    names.push(...page.segment.containerItems.map((container) => container.name));
  }
  return names;
}

async function listBlobNames(containerName: string, blobService: BlobServiceClient): Promise<string[]> {
  const container = blobService.getContainerClient(containerName);
  const names: string[] = [];

  for await (const page of container.listBlobsFlat().byPage({ maxPageSize: 100 })) {
    names.push(...page.segment.blobItems.map((blob) => blob.name));
  }

  return names;
}

function generatePayload(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  while (text.length < length) {
    text += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return text.slice(0, length);
}

async function listRowKeys(tableClient: TableClient): Promise<string[]> {
  const rows: string[] = [];
  for await (const page of tableClient.list().byPage({ maxPageSize: 10 })) {
    rows.push(...page.value.map((entity) => String(entity.rowKey)));
  }

  return rows;
}

async function runBlobBenchmark(
  stats: BenchmarkStats,
  blobService: BlobServiceClient,
  runIndex: number,
  record: boolean,
): Promise<void> {
  const suffix = randomToken().replace(/-/g, "");
  const containerName = `azbenchblob-${runIndex}-${suffix}`.slice(0, 50);
  const blobName = `payload-${runIndex}.txt`;
  const container = blobService.getContainerClient(containerName);
  const blob = container.getBlockBlobClient(blobName);
  const payload = generatePayload(1024);

  try {
    const createResponse = await measure(
      stats,
      "blob.create-container",
      async () => {
        return container.createIfNotExists();
      },
      record,
    );
    if (!createResponse.succeeded && createResponse.errorCode !== "ContainerAlreadyExists") {
      throw new Error(`container create failed: ${JSON.stringify(createResponse)}`);
    }

    await measure(
      stats,
      "blob.upload",
      async () => {
        await blob.upload(payload, payload.length);
      },
      record,
    );

    await measure(
      stats,
      "blob.download",
      async () => {
        const response = await blob.download(0, payload.length);
        const read = await response.text();
        if (read !== payload) {
          throw new Error("blob content mismatch");
        }
      },
      record,
    );

    const containsContainer = await waitUntil(
      async () => {
        const names = await listContainerNames(blobService);
        return names.includes(containerName);
      },
      5,
      250,
    );

    if (!containsContainer) {
      throw new Error("created container not observed in service list");
    }

    if (record) {
      await measure(
        stats,
        "blob.list-containers",
        async () => {
          const names = await listContainerNames(blobService);
          if (!names.includes(containerName)) {
            throw new Error("container name not found in listing");
          }
        },
        record,
      );
    }

    const containsBlob = await waitUntil(
      async () => {
        const names = await listBlobNames(containerName, blobService);
        return names.includes(blobName);
      },
      5,
      250,
    );

    if (!containsBlob) {
      throw new Error("created blob not observed in container list");
    }

    if (record) {
      await measure(
        stats,
        "blob.list-blobs",
        async () => {
          const names = await listBlobNames(containerName, blobService);
          if (!names.includes(blobName)) {
            throw new Error("blob name not found in container listing");
          }
        },
        record,
      );
    }

    const deleteResponse = await measure(
      stats,
      "blob.delete-blob",
      async () => {
        return blob.deleteIfExists();
      },
      record,
    );

    if (!deleteResponse.succeeded && deleteResponse.errorCode !== "BlobNotFound") {
      throw new Error(`blob delete failed: ${JSON.stringify(deleteResponse)}`);
    }
  } finally {
    if (record) {
      await measure(stats, "blob.delete-container", async () => {
        await container.deleteIfExists();
      });
    } else {
      await container.deleteIfExists();
    }
  }
}

async function runTableBenchmark(
  stats: BenchmarkStats,
  tableService: TableServiceClient,
  runIndex: number,
  record: boolean,
): Promise<void> {
  const suffix = randomToken().replace(/-/g, "");
  const tableName = `azbenchtable${runIndex}${suffix}`.slice(0, 48);
  const partitionKey = `pk${runIndex}`;
  const rowKey = `rk${runIndex}`;
  const payload = `payload-${runIndex}-${randomToken()}`;
  const tableClient = tableService.getTableClient(tableName);

  try {
    const createResponse = await measure(
      stats,
      "table.create-table",
      async () => {
        return tableService.createTableIfNotExists(tableName);
      },
      record,
    );

    if (!createResponse.succeeded && createResponse.errorCode !== "TableAlreadyExists") {
      throw new Error(`table create failed: ${JSON.stringify(createResponse)}`);
    }

    await measure(
      stats,
      "table.upsert-entity",
      async () => {
        await tableClient.upsertEntity({
          partitionKey,
          rowKey,
          value: payload,
        });
      },
      record,
    );

    await measure(
      stats,
      "table.get-entity",
      async () => {
        const entity = await tableClient.getEntity(partitionKey, rowKey);
        if (entity == null || entity.value !== payload) {
          throw new Error("entity mismatch for table upsert/read");
        }
      },
      record,
    );

    if (record) {
      await measure(
        stats,
        "table.list-entities",
        async () => {
          const rows = await listRowKeys(tableClient);
          if (!rows.includes(rowKey)) {
            throw new Error("inserted row not found in entity listing");
          }
        },
        record,
      );
    }

    await measure(
      stats,
      "table.delete-entity",
      async () => {
        const response = await tableClient.deleteEntity(partitionKey, rowKey);
        if (!response.succeeded) {
          throw new Error(`delete entity failed: ${JSON.stringify(response)}`);
        }
      },
      record,
    );
  } finally {
    if (record) {
      await measure(stats, "table.delete-table", async () => {
        await tableService.deleteTableIfExists(tableName);
      });
    } else {
      await tableService.deleteTableIfExists(tableName);
    }
  }
}

function printSummary(stats: BenchmarkStats, durationMs: number): void {
  console.log("\nStorage benchmark summary");
  console.log(`Wall clock: ${formatMs(durationMs)}`);

  const labels = [...stats.keys()].sort();
  for (const label of labels) {
    const samples = stats.get(label);
    if (samples == null || samples.length === 0) {
      continue;
    }

    const values = samples.toSorted((a, b) => a - b);
    const count = values.length;
    const average = values.reduce((sum, value) => sum + value, 0) / count;
    const minimum = values[0] ?? 0;
    const maximum = values[values.length - 1] ?? 0;
    const p50 = toPercentile(values, 0.5);
    const p95 = toPercentile(values, 0.95);
    const p99 = toPercentile(values, 0.99);

    console.log(
      `${label.padEnd(22)} count=${String(count).padStart(3)} avg=${formatMs(average)} p50=${formatMs(p50)} p95=${formatMs(p95)} p99=${formatMs(p99)} min=${formatMs(minimum)} max=${formatMs(maximum)}`,
    );
  }
}

async function main(): Promise<void> {
  if (!runBenchmark) {
    console.error(
      "Storage benchmark is disabled. Set AZUREFETCH_RUN_STORAGE_BENCHMARK=1 and required Azure Storage env vars before running.",
    );
    process.exit(1);
  }

  const resolvedMode: BenchmarkMode = {
    testConfig: parseConfig(),
    iterations: Number.isNaN(iterations) || iterations <= 0 ? 5 : iterations,
    warmup: Number.isNaN(warmup) || warmup < 0 ? 1 : warmup,
  };

  if (resolvedMode.testConfig == null) {
    console.error("No storage benchmark configuration available.");
    console.error("Set AZUREFETCH_STORAGE_CONNECTION_STRING for shared-key or set account+service-principal vars.");
    process.exit(1);
  }

  const credential = new DefaultAzureCredential();

  const blobService =
    resolvedMode.testConfig.kind === "connection-string"
      ? BlobServiceClient.fromConnectionString(resolvedMode.testConfig.connectionString)
      : new BlobServiceClient(resolvedMode.testConfig.blobEndpoint, credential);

  const tableService =
    resolvedMode.testConfig.kind === "connection-string"
      ? TableServiceClient.fromConnectionString(resolvedMode.testConfig.connectionString)
      : new TableServiceClient(resolvedMode.testConfig.tableEndpoint, credential);

  console.log(`Running storage benchmark (${resolvedMode.iterations} iterations + ${resolvedMode.warmup} warmup).`);
  console.log(`Mode: ${resolvedMode.testConfig.kind}`);

  const stats: BenchmarkStats = new Map();
  const start = performance.now();

  for (let index = 0; index < resolvedMode.iterations + resolvedMode.warmup; index += 1) {
    const shouldRecord = index >= resolvedMode.warmup;
    const runId = index + 1;

    console.log(`Run ${runId} ${shouldRecord ? "[recording]" : "[warmup]"}`);

    await runBlobBenchmark(stats, blobService, runId, shouldRecord);
    await runTableBenchmark(stats, tableService, runId, shouldRecord);
  }

  printSummary(stats, performance.now() - start);
}

await main();
