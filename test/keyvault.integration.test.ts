import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DefaultAzureCredential, KeyVaultRequestError, KeyVaultSecretClient } from "../src/node";

const runKeyVaultTests = process.env.AZUREFETCH_RUN_KEYVAULT_TESTS === "1";
const keyVaultUrl = process.env.AZUREFETCH_KEYVAULT_URL;
const purgeDeletedSecrets = process.env.AZUREFETCH_KEYVAULT_PURGE_TESTS === "1";
const tenantId = process.env.AZURE_TENANT_ID;
const clientId = process.env.AZURE_CLIENT_ID;
const clientSecret = process.env.AZURE_CLIENT_SECRET;

const shouldRunIntegration =
  runKeyVaultTests && keyVaultUrl != null && tenantId != null && clientId != null && clientSecret != null;

if (shouldRunIntegration) {
  describe("key vault integration (manual)", () => {
    if (keyVaultUrl == null) {
      return;
    }

    const credential = new DefaultAzureCredential();
    const client = new KeyVaultSecretClient(keyVaultUrl, credential);

    describe.sequential("secret lifecycle", () => {
      const runToken = randomToken();
      const secretName = `azfetch-secret-${runToken}`;
      const initialTags = { suite: "azfetch", run: runToken, stage: "initial" };
      const updatedTags = { suite: "azfetch", run: runToken, stage: "updated" };

      let createdSecret!: Awaited<ReturnType<KeyVaultSecretClient["setSecret"]>>;
      let latestSecret!: Awaited<ReturnType<KeyVaultSecretClient["setSecret"]>>;
      let deleted = false;
      let purged = false;

      beforeAll(async () => {
        createdSecret = await client.setSecret(secretName, "hello-keyvault", {
          contentType: "text/plain",
          enabled: true,
          tags: initialTags,
        });

        latestSecret = await client.setSecret(secretName, "hello-keyvault-v2", {
          contentType: "text/plain",
          enabled: true,
          tags: { ...initialTags, stage: "latest" },
        });
      }, 120_000);

      afterAll(async () => {
        await cleanupSecret(client, secretName, { deleted, purged });
      }, 120_000);

      test("setSecret creates the initial secret version", () => {
        expect(createdSecret.name).toBe(secretName);
        expect(createdSecret.value).toBe("hello-keyvault");
        expect(createdSecret.properties.contentType).toBe("text/plain");
        expect(createdSecret.properties.tags).toMatchObject(initialTags);
        expect(createdSecret.properties.version).toBeTruthy();
      });

      test("setSecret creates a newer secret version for the same name", () => {
        expect(latestSecret.name).toBe(secretName);
        expect(latestSecret.value).toBe("hello-keyvault-v2");
        expect(latestSecret.properties.version).toBeTruthy();
        expect(latestSecret.properties.version).not.toBe(createdSecret.properties.version);
      });

      test("getSecret returns the latest value", async () => {
        const fetched = await client.getSecret(secretName);

        expect(fetched.value).toBe("hello-keyvault-v2");
        expect(fetched.properties.version).toBe(latestSecret.properties.version);
      });

      test("getSecret returns a non-latest version when requested explicitly", async () => {
        const fetched = await client.getSecret(secretName, { version: requireVersion(createdSecret) });

        expect(fetched.value).toBe("hello-keyvault");
        expect(fetched.properties.version).toBe(createdSecret.properties.version);
      });

      test("updateSecretProperties updates metadata without changing the value", async () => {
        const updated = await client.updateSecretProperties(secretName, requireVersion(createdSecret), {
          contentType: "application/json",
          tags: updatedTags,
        });

        expect(updated.version).toBe(createdSecret.properties.version);
        expect(updated.contentType).toBe("application/json");
        expect(updated.enabled).toBe(true);
        expect(updated.tags).toMatchObject(updatedTags);
      });

      test("listPropertiesOfSecrets includes the created secret", async () => {
        expect(await listContainsSecret(client, secretName)).toBe(true);
      });

      test("listPropertiesOfSecretVersions includes the created version", async () => {
        expect(await listContainsSecretVersion(client, secretName, requireVersion(createdSecret))).toBe(true);
      });

      test("listPropertiesOfSecretVersions includes the newest version", async () => {
        expect(await listContainsSecretVersion(client, secretName, requireVersion(latestSecret))).toBe(true);
      });

      test("deleteSecret returns deleted secret metadata", async () => {
        const deletedSecret = await client.deleteSecret(secretName);
        deleted = true;

        expect(deletedSecret.name).toBe(secretName);
        expect(deletedSecret.recoveryId).toBeTruthy();
      });

      test("getDeletedSecret becomes readable after delete", async () => {
        const fetchedDeleted = await waitForDeletedSecret(client, secretName);

        expect(fetchedDeleted.recoveryId).toBeTruthy();
        expect(fetchedDeleted.deletedOn).toBeInstanceOf(Date);
      });

      test("listDeletedSecrets includes the deleted secret", async () => {
        expect(await listContainsDeletedSecret(client, secretName)).toBe(true);
      });

      test("recoverDeletedSecret makes the secret readable again", async () => {
        const recovered = await recoverDeletedSecretEventually(client, secretName);
        deleted = false;

        expect(recovered.name).toBe(secretName);

        const recoveredSecret = await waitForRecoveredSecret(client, secretName);
        expect(recoveredSecret.value).toBe("hello-keyvault-v2");
        expect(recoveredSecret.properties.version).toBe(requireVersion(latestSecret));

        const recoveredInitialVersion = await client.getSecret(secretName, { version: requireVersion(createdSecret) });
        expect(recoveredInitialVersion.value).toBe("hello-keyvault");
      });

      if (purgeDeletedSecrets) {
        test("purgeDeletedSecret permanently removes the deleted secret", async () => {
          await client.deleteSecret(secretName);
          deleted = true;

          await waitForDeletedSecret(client, secretName);
          await purgeDeletedSecretEventually(client, secretName);
          purged = true;
          deleted = false;

          await expect(client.getDeletedSecret(secretName)).rejects.toMatchObject({
            status: 404,
          });
        }, 120_000);
      } else {
        test.skip("purgeDeletedSecret permanently removes the deleted secret", () => {});
      }
    });
  });
} else {
  describe.skip("key vault integration (manual)", () => {
    test("requires AZUREFETCH_RUN_KEYVAULT_TESTS and Key Vault credentials", () => {});
  });
}

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function requireVersion(secret: { properties: { version?: string } }): string {
  const version = secret.properties.version;
  if (version == null) {
    throw new Error("Expected secret to include a version");
  }

  return version;
}

async function cleanupSecret(
  client: KeyVaultSecretClient,
  secretName: string,
  state: { deleted: boolean; purged: boolean },
): Promise<void> {
  if (state.purged) {
    return;
  }

  try {
    if (!state.deleted) {
      await client.deleteSecret(secretName);
      state.deleted = true;
    }

    if (!purgeDeletedSecrets) {
      return;
    }

    await waitForDeletedSecret(client, secretName);
    await purgeDeletedSecretEventually(client, secretName);
    state.purged = true;
  } catch {
    return;
  }
}

async function listContainsSecret(client: KeyVaultSecretClient, secretName: string): Promise<boolean> {
  for await (const page of client.listPropertiesOfSecrets().byPage({ maxPageSize: 25 })) {
    if (page.value.some((secret) => secret.name === secretName)) {
      return true;
    }
  }

  return false;
}

async function listContainsDeletedSecret(client: KeyVaultSecretClient, secretName: string): Promise<boolean> {
  for await (const page of client.listDeletedSecrets().byPage({ maxPageSize: 25 })) {
    if (page.value.some((secret) => secret.name === secretName)) {
      return true;
    }
  }

  return false;
}

async function listContainsSecretVersion(
  client: KeyVaultSecretClient,
  secretName: string,
  version: string,
): Promise<boolean> {
  for await (const page of client.listPropertiesOfSecretVersions(secretName).byPage({ maxPageSize: 25 })) {
    if (page.value.some((secret) => secret.version === version)) {
      return true;
    }
  }

  return false;
}

async function waitForDeletedSecret(
  client: KeyVaultSecretClient,
  secretName: string,
): Promise<Awaited<ReturnType<KeyVaultSecretClient["getDeletedSecret"]>>> {
  return pollKeyVaultOperation(async () => client.getDeletedSecret(secretName), "deleted secret visibility");
}

async function waitForRecoveredSecret(
  client: KeyVaultSecretClient,
  secretName: string,
): Promise<Awaited<ReturnType<KeyVaultSecretClient["getSecret"]>>> {
  return pollKeyVaultOperation(async () => client.getSecret(secretName), "recovered secret visibility");
}

async function recoverDeletedSecretEventually(
  client: KeyVaultSecretClient,
  secretName: string,
): Promise<Awaited<ReturnType<KeyVaultSecretClient["recoverDeletedSecret"]>>> {
  return pollKeyVaultOperation(async () => client.recoverDeletedSecret(secretName), "secret recovery");
}

async function purgeDeletedSecretEventually(client: KeyVaultSecretClient, secretName: string): Promise<void> {
  await pollKeyVaultOperation(async () => {
    await client.purgeDeletedSecret(secretName);
    return undefined;
  }, "secret purge");
}

async function pollKeyVaultOperation<T>(operation: () => Promise<T>, description: string): Promise<T> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableKeyVaultStateError(error)) {
        throw error;
      }

      lastError = error;
      await sleep(2_000);
    }
  }

  throw new Error(`Timed out waiting for ${description}${formatLastError(lastError)}`);
}

function isRetryableKeyVaultStateError(error: unknown): boolean {
  return error instanceof KeyVaultRequestError && (error.status === 404 || error.status === 409);
}

function formatLastError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return `: ${error.message}`;
  }

  return "";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
