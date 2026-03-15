interface TableEntityLike {
  partitionKey?: unknown;
  rowKey?: unknown;
  PartitionKey?: unknown;
  RowKey?: unknown;
  [key: string]: unknown;
}

export interface ParsedTableEntity extends Record<string, unknown> {
  partitionKey: string;
  rowKey: string;
}

export function getPartitionKey(entity: TableEntityLike): string {
  if (typeof entity.partitionKey === "string") {
    return entity.partitionKey;
  }

  if (typeof entity.PartitionKey === "string") {
    return entity.PartitionKey;
  }

  throw new Error("Entity is missing PartitionKey/partitionKey");
}

export function getRowKey(entity: TableEntityLike): string {
  if (typeof entity.rowKey === "string") {
    return entity.rowKey;
  }

  if (typeof entity.RowKey === "string") {
    return entity.RowKey;
  }

  throw new Error("Entity is missing RowKey/rowKey");
}

export function normalizeEntityPayload(
  entity: TableEntityLike,
  partitionKey: string,
  rowKey: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(entity)) {
    if (name === "partitionKey" || name === "rowKey") {
      continue;
    }

    if (value !== undefined) {
      payload[name] = value;
    }
  }

  payload.PartitionKey = partitionKey;
  payload.RowKey = rowKey;

  return payload;
}

export function parseTableEntity(rawEntity: unknown): ParsedTableEntity {
  if (!isRecord(rawEntity)) {
    throw new Error("Invalid table entity response");
  }

  const partitionKeyRaw = rawEntity.PartitionKey;
  const rowKeyRaw = rawEntity.RowKey;

  if (typeof partitionKeyRaw !== "string" || typeof rowKeyRaw !== "string") {
    throw new Error("Invalid table entity response");
  }

  const entity: ParsedTableEntity = {
    partitionKey: partitionKeyRaw,
    rowKey: rowKeyRaw,
  };

  for (const [name, value] of Object.entries(rawEntity)) {
    if (name === "PartitionKey" || name === "RowKey") {
      continue;
    }

    entity[name] = value;
  }

  return entity;
}

export function parseTableEntityList(body: string): ParsedTableEntity[] {
  if (body.length === 0) {
    return [];
  }

  const parsed = parseJson(body);
  if (!isRecord(parsed)) {
    return [];
  }

  const rawEntities = parsed.value;
  if (!Array.isArray(rawEntities)) {
    return [];
  }

  const entities: ParsedTableEntity[] = [];
  for (const entity of rawEntities) {
    if (!isRecord(entity)) {
      continue;
    }

    if (typeof entity.PartitionKey !== "string" || typeof entity.RowKey !== "string") {
      continue;
    }

    entities.push(parseTableEntity(entity));
  }

  return entities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}
