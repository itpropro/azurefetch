import { nativeBenchmarkDriver, sdkBenchmarkDriver } from "./drivers";
import type { BenchmarkMode, BenchmarkStats, StorageBenchmarkDriver, TestConfig } from "./types";

type BenchmarkConfig = {
  mode: BenchmarkMode & { batchSize: number };
  selectedDrivers: ReadonlyArray<StorageBenchmarkDriver>;
};

const requiredEnvVar = "AZUREFETCH_RUN_STORAGE_BENCHMARK";
const runBenchmark = process.env[requiredEnvVar] === "1";

const storageConnectionString = process.env.AZUREFETCH_STORAGE_CONNECTION_STRING;
const storageAuthMode = process.env.AZUREFETCH_STORAGE_AUTH_MODE;
const storageAccountName = process.env.AZUREFETCH_STORAGE_ACCOUNT_NAME;
const storageEndpointSuffix = process.env.AZUREFETCH_STORAGE_ENDPOINT_SUFFIX || "core.windows.net";
const tenantId = process.env.AZURE_TENANT_ID;
const clientId = process.env.AZURE_CLIENT_ID;
const clientSecret = process.env.AZURE_CLIENT_SECRET;
const blobEndpointFromEnv = process.env.AZUREFETCH_STORAGE_BLOB_ENDPOINT;
const tableEndpointFromEnv = process.env.AZUREFETCH_STORAGE_TABLE_ENDPOINT;
const batchSizeFromEnv = process.env.AZUREFETCH_BENCHMARK_BATCH_SIZE;
const iterationsFromEnv = process.env.AZUREFETCH_BENCHMARK_ITERATIONS;
const warmupFromEnv = process.env.AZUREFETCH_BENCHMARK_WARMUP;

const includeDetailedPercentiles =
  process.argv.includes("--detailed") || process.env.AZUREFETCH_BENCHMARK_DETAILED === "1";
const driverSelection = (process.env.AZUREFETCH_BENCHMARK_DRIVER ?? "both").toLowerCase();

function parseInteger(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed >= minimum ? parsed : minimum;
}

function parseTestConfig(): TestConfig | undefined {
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

function parseBenchmarkDrivers(): StorageBenchmarkDriver[] {
  const allDrivers = {
    native: nativeBenchmarkDriver,
    sdk: sdkBenchmarkDriver,
  } as const;

  if (driverSelection === "native") {
    return [allDrivers.native];
  }

  if (driverSelection === "sdk") {
    return [allDrivers.sdk];
  }

  if (driverSelection !== "both") {
    const allowed = Object.keys(allDrivers).join(", ");
    console.error(`Unsupported AZUREFETCH_BENCHMARK_DRIVER value: ${driverSelection}`);
    console.error(`Supported values are: both, native, sdk.`);
    console.error(`Default is both.`);
    console.error(`To use a single driver, set AZUREFETCH_BENCHMARK_DRIVER to ${allowed}.`);
    process.exit(1);
  }

  return [allDrivers.native, allDrivers.sdk];
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

  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile));

  return sorted[index] ?? 0;
}

const summaryColumns = {
  operationWidth: 40,
  timeWidth: 12,
} as const;

function formatOperationLabel(label: string): string {
  return label.padEnd(summaryColumns.operationWidth);
}

function formatSummaryTime(value: number): string {
  return formatMs(value).padStart(summaryColumns.timeWidth);
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

async function measure<T>(
  stats: BenchmarkStats,
  operationLabel: string,
  fn: () => Promise<T>,
  shouldRecord = true,
): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;

  if (shouldRecord) {
    const samples = stats.get(operationLabel);
    if (samples == null) {
      stats.set(operationLabel, [elapsed]);
    } else {
      samples.push(elapsed);
    }
  }

  return result;
}

function generatePayload(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";

  while (text.length < length) {
    text += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  }

  return text.slice(0, length);
}

async function runBlobBenchmark(
  stats: BenchmarkStats,
  mode: BenchmarkMode,
  driver: StorageBenchmarkDriver,
  runIndex: number,
  shouldRecord: boolean,
): Promise<void> {
  const suffix = randomToken().replace(/-/g, "");
  const service = await driver.createBlobService(mode.testConfig);

  const containerName = `azbenchblob-${driver.id}-${runIndex}-${suffix}`.slice(0, 50);
  const blobName = `payload-${runIndex}.txt`;
  const payload = generatePayload(1024);

  try {
    const createResponse = await measure(
      stats,
      `${driver.id}.blob.create-container`,
      () => service.createContainer(containerName),
      shouldRecord,
    );

    if (!createResponse.succeeded && createResponse.errorCode !== "ContainerAlreadyExists") {
      throw new Error(`container create failed: ${JSON.stringify(createResponse)}`);
    }

    await measure(
      stats,
      `${driver.id}.blob.upload`,
      () => service.uploadBlob(containerName, blobName, payload),
      shouldRecord,
    );

    const text = await measure(
      stats,
      `${driver.id}.blob.download`,
      async () => {
        const downloaded = await service.downloadBlob(containerName, blobName, payload.length);
        if (downloaded !== payload) {
          throw new Error("blob content mismatch");
        }

        return downloaded;
      },
      shouldRecord,
    );

    if (!shouldRecord) {
      void text;
    }

    const containsContainer = await waitUntil(
      async () => {
        const names = await service.listContainerNames();
        return names.includes(containerName);
      },
      5,
      250,
    );

    if (!containsContainer) {
      throw new Error("created container not observed in service list");
    }

    if (shouldRecord) {
      await measure(
        stats,
        `${driver.id}.blob.list-containers`,
        async () => {
          const names = await service.listContainerNames();
          if (!names.includes(containerName)) {
            throw new Error("container name not found in listing");
          }
        },
        true,
      );
    }

    const containsBlob = await waitUntil(
      async () => {
        const names = await service.listBlobNames(containerName);
        return names.includes(blobName);
      },
      5,
      250,
    );

    if (!containsBlob) {
      throw new Error("created blob not observed in container list");
    }

    if (shouldRecord) {
      await measure(
        stats,
        `${driver.id}.blob.list-blobs`,
        async () => {
          const names = await service.listBlobNames(containerName);
          if (!names.includes(blobName)) {
            throw new Error("blob name not found in container listing");
          }
        },
        true,
      );
    }

    const deleteResponse = await measure(
      stats,
      `${driver.id}.blob.delete-blob`,
      () => service.deleteBlob(containerName, blobName),
      shouldRecord,
    );
    if (!deleteResponse.succeeded && deleteResponse.errorCode !== "BlobNotFound") {
      throw new Error(`blob delete failed: ${JSON.stringify(deleteResponse)}`);
    }
  } finally {
    await measure(
      stats,
      `${driver.id}.blob.delete-container`,
      () => service.deleteContainer(containerName),
      shouldRecord,
    );
  }
}

async function runTableBenchmark(
  stats: BenchmarkStats,
  mode: BenchmarkMode,
  driver: StorageBenchmarkDriver,
  runIndex: number,
  shouldRecord: boolean,
): Promise<void> {
  const service = await driver.createTableService(mode.testConfig);
  const suffix = randomToken().replace(/-/g, "");
  const tableName = `azbenchtable${driver.id}${runIndex}${suffix}`.slice(0, 48);
  const partitionKey = `pk${runIndex}`;
  const rowKey = `rk${runIndex}`;
  const payload = `payload-${runIndex}-${randomToken()}`;

  try {
    const createResponse = await measure(
      stats,
      `${driver.id}.table.create-table`,
      () => service.createTable(tableName),
      shouldRecord,
    );

    if (!createResponse.succeeded && createResponse.errorCode !== "TableAlreadyExists") {
      throw new Error(`table create failed: ${JSON.stringify(createResponse)}`);
    }

    await measure(
      stats,
      `${driver.id}.table.upsert-entity`,
      () => service.upsertEntity(tableName, partitionKey, rowKey, payload),
      shouldRecord,
    );

    await measure(
      stats,
      `${driver.id}.table.get-entity`,
      async () => {
        const entityValue = await service.getEntityValue(tableName, partitionKey, rowKey);
        if (entityValue !== payload) {
          throw new Error("entity payload mismatch for table get");
        }
      },
      shouldRecord,
    );

    if (shouldRecord) {
      await measure(
        stats,
        `${driver.id}.table.list-entities`,
        async () => {
          const observed = await waitUntil(
            async () => {
              const rows = await service.listRowKeys(tableName);
              return rows.includes(rowKey);
            },
            5,
            250,
          );

          if (!observed) {
            throw new Error("inserted row not found in entity listing");
          }
        },
        true,
      );
    }

    const deleteResponse = await measure(
      stats,
      `${driver.id}.table.delete-entity`,
      () => service.deleteEntity(tableName, partitionKey, rowKey),
      shouldRecord,
    );
    if (!deleteResponse.succeeded && deleteResponse.errorCode !== "ResourceNotFound") {
      throw new Error(`table entity delete failed: ${JSON.stringify(deleteResponse)}`);
    }
  } finally {
    await measure(stats, `${driver.id}.table.delete-table`, () => service.deleteTable(tableName), shouldRecord);
  }
}

async function runBlobBatchBenchmark(
  stats: BenchmarkStats,
  mode: BenchmarkMode,
  driver: StorageBenchmarkDriver,
  runIndex: number,
  shouldRecord: boolean,
): Promise<void> {
  if (mode.batchSize <= 0) {
    return;
  }

  const service = await driver.createBlobService(mode.testConfig);
  const suffix = randomToken().replace(/-/g, "");
  const containerName = `azbenchbatch-${driver.id}-${runIndex}-${suffix}`.slice(0, 50);
  const blobNames = Array.from({ length: mode.batchSize }, (_, index) => `batch-${index}.txt`);
  const payload = generatePayload(1024);

  try {
    const createResponse = await measure(
      stats,
      `${driver.id}.blob.batch-create-container`,
      () => service.createContainer(containerName),
      shouldRecord,
    );

    if (!createResponse.succeeded && createResponse.errorCode !== "ContainerAlreadyExists") {
      throw new Error(`batch container create failed: ${JSON.stringify(createResponse)}`);
    }

    await measure(
      stats,
      `${driver.id}.blob.batch-upload`,
      () => service.uploadBatchBlobs(containerName, blobNames, payload),
      shouldRecord,
    );

    const removeResponse = await measure(
      stats,
      `${driver.id}.blob.batch-delete`,
      () => service.deleteBlobBatch(containerName, blobNames),
      shouldRecord,
    );

    if (removeResponse.status < 200 || removeResponse.status >= 300) {
      throw new Error(`batch delete failed with status ${removeResponse.status}`);
    }

    if (removeResponse.succeededCount + removeResponse.failedCount !== mode.batchSize) {
      throw new Error(
        `batch delete mismatch: expected ${mode.batchSize}, got succeeded=${removeResponse.succeededCount}, failed=${removeResponse.failedCount}`,
      );
    }
  } finally {
    await measure(
      stats,
      `${driver.id}.blob.batch-delete-container`,
      () => service.deleteContainer(containerName),
      shouldRecord,
    );
  }
}

function printSummary(stats: BenchmarkStats, durationMs: number): void {
  console.log("\nStorage benchmark summary");
  console.log(`Wall clock: ${formatMs(durationMs)}`);

  const header =
    `Operation`.padEnd(summaryColumns.operationWidth) +
    `avg`.padStart(summaryColumns.timeWidth + 1) +
    (includeDetailedPercentiles
      ? `p50`.padStart(summaryColumns.timeWidth + 1) +
        `p95`.padStart(summaryColumns.timeWidth + 1) +
        `p99`.padStart(summaryColumns.timeWidth + 1) +
        `min`.padStart(summaryColumns.timeWidth + 1) +
        `max`.padStart(summaryColumns.timeWidth + 1)
      : `min`.padStart(summaryColumns.timeWidth + 1) + `max`.padStart(summaryColumns.timeWidth + 1));

  console.log(header);

  const labels = [...stats.keys()].sort((left, right) => left.localeCompare(right));

  for (const label of labels) {
    const samples = stats.get(label);
    if (samples == null || samples.length === 0) {
      continue;
    }

    const values = samples.toSorted((left, right) => left - right);
    const count = values.length;
    const average = values.reduce((sum, value) => sum + value, 0) / count;
    const minimum = values[0] ?? 0;
    const maximum = values[values.length - 1] ?? 0;

    if (!includeDetailedPercentiles) {
      console.log(
        `${formatOperationLabel(label)} ${formatSummaryTime(average)} ${formatSummaryTime(minimum)} ${formatSummaryTime(maximum)}`,
      );

      continue;
    }

    const p50 = toPercentile(values, 0.5);
    const p95 = toPercentile(values, 0.95);
    const p99 = toPercentile(values, 0.99);

    console.log(
      `${formatOperationLabel(label)} ${formatSummaryTime(average)} ${formatSummaryTime(
        p50,
      )} ${formatSummaryTime(p95)} ${formatSummaryTime(p99)} ${formatSummaryTime(minimum)} ${formatSummaryTime(maximum)}`,
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

  const selectedDrivers = parseBenchmarkDrivers();
  const mode: BenchmarkConfig["mode"] = {
    testConfig: parseTestConfig(),
    iterations: parseInteger(iterationsFromEnv, 5, 1),
    warmup: parseInteger(warmupFromEnv, 1, 0),
    batchSize: parseInteger(batchSizeFromEnv, 50, 1),
  };

  if (mode.testConfig == null) {
    console.error("No storage benchmark configuration available.");
    console.error("Set AZUREFETCH_STORAGE_CONNECTION_STRING for shared-key or set account+service-principal vars.");
    process.exit(1);
  }

  const config: BenchmarkConfig = {
    mode,
    selectedDrivers,
  };

  const requestedDrivers = config.selectedDrivers.map((driver) => driver.id).join(", ");
  console.log(
    `Running storage benchmark (${config.mode.iterations} iterations + ${config.mode.warmup} warmup) across ${requestedDrivers}.`,
  );
  console.log(`Mode: ${config.mode.testConfig.kind}`);
  console.log(`Batch size: ${config.mode.batchSize}`);

  const stats: BenchmarkStats = new Map();
  const start = performance.now();

  for (let index = 0; index < config.mode.iterations + config.mode.warmup; index += 1) {
    const shouldRecord = index >= config.mode.warmup;
    const runId = index + 1;
    for (const driver of config.selectedDrivers) {
      await runBlobBenchmark(stats, config.mode, driver, runId, shouldRecord);
      await runTableBenchmark(stats, config.mode, driver, runId, shouldRecord);
      await runBlobBatchBenchmark(stats, config.mode, driver, runId, shouldRecord);
    }
  }

  printSummary(stats, performance.now() - start);
}

await main();
