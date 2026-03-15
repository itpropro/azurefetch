import type { DeletedSecret, KeyVaultSecret, SecretProperties } from "../keyvault-secrets";

interface SecretAttributesRecord {
  enabled?: boolean;
  nbf?: number | string;
  exp?: number | string;
  created?: number | string;
  updated?: number | string;
  recoveryLevel?: string;
  recoverableDays?: number;
}

interface SecretRecord {
  id?: string;
  value?: string;
  contentType?: string;
  attributes?: SecretAttributesRecord;
  tags?: Record<string, unknown>;
  managed?: boolean;
  kid?: string;
  recoveryId?: string;
  scheduledPurgeDate?: number | string;
  deletedDate?: number | string;
}

interface ParsedIdentifier {
  vaultUrl?: string;
  name?: string;
  version?: string;
}

interface SecretListRecord {
  value?: unknown[];
  nextLink?: string;
}

export interface ParsedSecretList<T> {
  value: T[];
  continuationToken?: string;
}

export function parseKeyVaultSecret(value: unknown, vaultUrl: string, secretName?: string): KeyVaultSecret {
  const secret = parseSecretRecord(value);
  const properties = parseSecretProperties(secret, vaultUrl, secretName);

  return {
    name: properties.name,
    value: secret.value,
    properties,
  };
}

export function parseDeletedKeyVaultSecret(value: unknown, vaultUrl: string, secretName?: string): DeletedSecret {
  const secret = parseSecretRecord(value);
  const properties = parseSecretProperties(secret, vaultUrl, secretName);
  const deletedOn = parseUnixTimestamp(secret.deletedDate);
  const scheduledPurgeDate = parseUnixTimestamp(secret.scheduledPurgeDate);

  if (secret.recoveryId != null) {
    properties.recoveryId = secret.recoveryId;
  }

  if (deletedOn != null) {
    properties.deletedOn = deletedOn;
  }

  if (scheduledPurgeDate != null) {
    properties.scheduledPurgeDate = scheduledPurgeDate;
  }

  return {
    name: properties.name,
    value: secret.value,
    properties,
    recoveryId: secret.recoveryId,
    deletedOn,
    scheduledPurgeDate,
  };
}

export function parseSecretProperties(value: unknown, vaultUrl: string, secretName?: string): SecretProperties {
  const secret = parseSecretRecord(value);
  const identifier = parseKeyVaultSecretIdentifier(secret.id);
  const attributes = secret.attributes;

  return {
    vaultUrl: identifier.vaultUrl ?? vaultUrl,
    name: identifier.name ?? secretName ?? "",
    version: identifier.version,
    id: secret.id,
    contentType: secret.contentType,
    enabled: attributes?.enabled,
    notBefore: parseUnixTimestamp(attributes?.nbf),
    expiresOn: parseUnixTimestamp(attributes?.exp),
    tags: parseStringMap(secret.tags),
    certificateKeyId: secret.kid,
    managed: secret.managed,
    createdOn: parseUnixTimestamp(attributes?.created),
    updatedOn: parseUnixTimestamp(attributes?.updated),
    recoveryLevel: attributes?.recoveryLevel,
    recoverableDays: attributes?.recoverableDays,
  };
}

export function parseSecretList<T>(value: unknown, mapper: (item: unknown) => T): ParsedSecretList<T> {
  const record = parseSecretListRecord(value);
  return {
    value: (record.value ?? []).map((item) => mapper(item)),
    continuationToken: normalizeContinuationToken(record.nextLink),
  };
}

export function parseKeyVaultSecretIdentifier(identifier: string | undefined): ParsedIdentifier {
  if (identifier == null || identifier.length === 0) {
    return {};
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(identifier);
  } catch {
    return {};
  }

  const segments = parsedUrl.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return {};
  }

  const [collection, name, version] = segments;
  if ((collection !== "secrets" && collection !== "deletedsecrets") || name == null) {
    return {};
  }

  return {
    vaultUrl: parsedUrl.origin,
    name: decodeURIComponent(name),
    version: version == null ? undefined : decodeURIComponent(version),
  };
}

function parseSecretRecord(value: unknown): SecretRecord {
  if (!isRecord(value)) {
    return {};
  }

  const attributes = isRecord(value.attributes) ? value.attributes : undefined;
  const parsedAttributes: SecretAttributesRecord | undefined =
    attributes == null
      ? undefined
      : {
          enabled: typeof attributes.enabled === "boolean" ? attributes.enabled : undefined,
          nbf: isStringOrNumber(attributes.nbf) ? attributes.nbf : undefined,
          exp: isStringOrNumber(attributes.exp) ? attributes.exp : undefined,
          created: isStringOrNumber(attributes.created) ? attributes.created : undefined,
          updated: isStringOrNumber(attributes.updated) ? attributes.updated : undefined,
          recoveryLevel: typeof attributes.recoveryLevel === "string" ? attributes.recoveryLevel : undefined,
          recoverableDays: typeof attributes.recoverableDays === "number" ? attributes.recoverableDays : undefined,
        };

  return {
    id: typeof value.id === "string" ? value.id : undefined,
    value: typeof value.value === "string" ? value.value : undefined,
    contentType: typeof value.contentType === "string" ? value.contentType : undefined,
    attributes: parsedAttributes,
    tags: isRecord(value.tags) ? value.tags : undefined,
    managed: typeof value.managed === "boolean" ? value.managed : undefined,
    kid: typeof value.kid === "string" ? value.kid : undefined,
    recoveryId: typeof value.recoveryId === "string" ? value.recoveryId : undefined,
    scheduledPurgeDate: isStringOrNumber(value.scheduledPurgeDate) ? value.scheduledPurgeDate : undefined,
    deletedDate: isStringOrNumber(value.deletedDate) ? value.deletedDate : undefined,
  };
}

function parseSecretListRecord(value: unknown): SecretListRecord {
  if (!isRecord(value)) {
    return {};
  }

  return {
    value: Array.isArray(value.value) ? value.value : undefined,
    nextLink: typeof value.nextLink === "string" ? value.nextLink : undefined,
  };
}

function parseStringMap(value: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (value == null) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function parseUnixTimestamp(value: number | string | undefined): Date | undefined {
  if (value == null) {
    return undefined;
  }

  const seconds = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(seconds)) {
    return undefined;
  }

  return new Date(seconds * 1000);
}

function normalizeContinuationToken(value: string | undefined): string | undefined {
  if (value == null || value.length === 0) {
    return undefined;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringOrNumber(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}
