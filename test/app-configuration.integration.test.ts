import { afterAll, describe, expect, test } from "vitest";

import { AppConfigurationClient } from "../src/index";
import { DefaultAzureCredential } from "../src/node";

const runAppConfigurationTests = process.env.AZUREFETCH_RUN_APP_CONFIGURATION_TESTS === "1";
const appConfigurationEndpoint =
  process.env.AZUREFETCH_APP_CONFIGURATION_ENDPOINT ??
  (process.env.AZUREFETCH_APP_CONFIGURATION_NAME
    ? `https://${process.env.AZUREFETCH_APP_CONFIGURATION_NAME}.${process.env.AZUREFETCH_APP_CONFIGURATION_ENDPOINT_SUFFIX ?? "azconfig.io"}`
    : undefined);
const tenantId = process.env.AZURE_TENANT_ID;
const clientId = process.env.AZURE_CLIENT_ID;
const clientSecret = process.env.AZURE_CLIENT_SECRET;

const shouldRunIntegration =
  runAppConfigurationTests &&
  appConfigurationEndpoint != null &&
  tenantId != null &&
  clientId != null &&
  clientSecret != null;

if (shouldRunIntegration) {
  describe("app configuration integration (manual)", () => {
    if (appConfigurationEndpoint == null) {
      return;
    }

    const credential = new DefaultAzureCredential();
    const runToken = randomToken();
    const label = `run-${runToken}`;
    const overrideLabel = `${label}-override`;
    const prefix = `TestApp:Service1:${runToken}`;
    const client = new AppConfigurationClient(appConfigurationEndpoint, credential, { prefix, label });
    const firstKey = "ApiEndpoint";
    const secondKey = "Titles/Welcome, Draft*\\日本語";
    const secondValue = "Line 1\nGrüße 🚀";

    afterAll(async () => {
      await cleanupSetting(client, firstKey);
      await cleanupSetting(client, secondKey);
      await cleanupSetting(client, firstKey, overrideLabel);
    }, 120_000);

    describe.sequential("key lifecycle", () => {
      test("setConfigurationSetting creates the first key", async () => {
        const created = await client.setConfigurationSetting(firstKey, "hello-appconfig", {
          contentType: "text/plain",
          tags: { suite: "azfetch", run: runToken, stage: "first" },
        });

        expect(created.key).toBe(firstKey);
        expect(created.label).toBe(label);
        expect(created.value).toBe("hello-appconfig");
        expect(created.contentType).toBe("text/plain");
        expect(created.tags).toMatchObject({ suite: "azfetch", run: runToken, stage: "first" });
        expect(created.etag).toBeTruthy();
      }, 120_000);

      test("setConfigurationSetting round-trips unicode key and value content", async () => {
        const created = await client.setConfigurationSetting(secondKey, secondValue, {
          contentType: "text/plain;charset=utf-8",
          tags: { suite: "azfetch", run: runToken, stage: "second" },
        });

        expect(created.key).toBe(secondKey);
        expect(created.label).toBe(label);
        expect(created.value).toBe(secondValue);
        expect(created.contentType).toBe("text/plain;charset=utf-8");
      }, 120_000);

      test("setConfigurationSetting supports a second label for the same key", async () => {
        const created = await client.setConfigurationSetting(firstKey, "hello-appconfig-override", {
          label: overrideLabel,
          tags: { suite: "azfetch", run: runToken, stage: "override" },
        });

        expect(created.key).toBe(firstKey);
        expect(created.label).toBe(overrideLabel);
        expect(created.value).toBe("hello-appconfig-override");
      }, 120_000);

      test("getConfigurationSetting reads the created key", async () => {
        const fetched = await client.getConfigurationSetting(firstKey);

        expect(fetched.key).toBe(firstKey);
        expect(fetched.label).toBe(label);
        expect(fetched.value).toBe("hello-appconfig");
        expect(fetched.contentType).toBe("text/plain");
        expect(fetched.tags).toMatchObject({ suite: "azfetch", run: runToken, stage: "first" });
      }, 120_000);

      test("getConfigurationSetting reads encoded key content without mangling", async () => {
        const fetched = await client.getConfigurationSetting(secondKey);

        expect(fetched.key).toBe(secondKey);
        expect(fetched.label).toBe(label);
        expect(fetched.value).toBe(secondValue);
        expect(fetched.contentType).toBe("text/plain;charset=utf-8");
      }, 120_000);

      test("getConfigurationSetting can target an explicit alternate label", async () => {
        const fetched = await client.getConfigurationSetting(firstKey, { label: overrideLabel });

        expect(fetched.key).toBe(firstKey);
        expect(fetched.label).toBe(overrideLabel);
        expect(fetched.value).toBe("hello-appconfig-override");
      }, 120_000);

      test("listConfigurationSettings scopes by the configured hierarchical prefix and default label", async () => {
        const listed: string[] = [];

        for await (const page of client.listConfigurationSettings().byPage()) {
          listed.push(...page.value.map((setting) => setting.key));
        }

        expect(listed.sort()).toEqual([firstKey, secondKey]);
      }, 120_000);

      test("deleteConfigurationSetting removes only the matching label variant", async () => {
        const deleted = await client.deleteConfigurationSetting(firstKey);

        expect(deleted?.key).toBe(firstKey);

        await expect(client.getConfigurationSetting(firstKey)).rejects.toMatchObject({
          status: 404,
        });

        const alternate = await client.getConfigurationSetting(firstKey, { label: overrideLabel });
        expect(alternate.value).toBe("hello-appconfig-override");
      }, 120_000);
    });
  });
} else {
  describe.skip("app configuration integration (manual)", () => {
    test("requires AZUREFETCH_RUN_APP_CONFIGURATION_TESTS, App Configuration endpoint, and service principal credentials", () => {});
  });
}

async function cleanupSetting(client: AppConfigurationClient, key: string, label?: string): Promise<void> {
  try {
    await client.deleteConfigurationSetting(key, { label });
  } catch {
    return;
  }
}

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
