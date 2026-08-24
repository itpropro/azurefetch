import { describe, expect, test, vi } from "vitest";

import { keyVaultOAuthScope } from "../src/internal/request-core";
import {
  KeyVaultRequestError,
  KeyVaultSecretClient,
  type DeletedSecret,
  type SecretProperties,
} from "../src/keyvault-secrets";
import { createFetchMock, getBodyString, jsonResponse, textResponse } from "./helpers";

describe("KeyVaultSecretClient", () => {
  test("rejects HTTP vault and authority URLs during construction", () => {
    const credential = { getAuthorizationHeader: vi.fn(async () => "Bearer token") };
    const fetcher = vi.fn<typeof fetch>();

    expect(() => new KeyVaultSecretClient("http://example.vault.azure.net", credential, { fetch: fetcher })).toThrow(
      "vaultUrl must use HTTPS",
    );
    expect(
      () =>
        new KeyVaultSecretClient("https://private.vault.local", credential, {
          authorityHost: "http://identity.test",
          fetch: fetcher,
        }),
    ).toThrow("authorityHost must use HTTPS");
    expect(credential.getAuthorizationHeader).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("supports HTTPS sovereign and private-link vault hosts", () => {
    expect(createClient(vi.fn<typeof fetch>()).url).toBe("https://example.vault.azure.net");
    expect(
      new KeyVaultSecretClient("https://vault.private-link.internal", undefined, {
        authorityHost: "https://login.microsoftonline.us",
      }).url,
    ).toBe("https://vault.private-link.internal");
  });

  describe("setSecret", () => {
    test("sends the default Key Vault scope and serializes secret attributes", async () => {
      const expiresOn = new Date("2027-01-01T00:00:00.000Z");
      const getAuthorizationHeader = vi.fn(async (scope?: string | string[]) => `Bearer ${scope}`);
      let capturedBody = "";

      const fetcher = createFetchMock([
        (url, init) => {
          capturedBody = getBodyString(init.body);
          expect(url).toBe("https://example.vault.azure.net/secrets/app-secret?api-version=7.6");
          expect(init.method).toBe("PUT");
          const headers = new Headers(init.headers);
          expect(headers.get("Authorization")).toBe(`Bearer ${keyVaultOAuthScope}`);
          expect(headers.get("Content-Type")).toBe("application/json");

          return jsonResponse({
            id: "https://example.vault.azure.net/secrets/app-secret/version-1",
            value: "secret-value",
            contentType: "text/plain",
            tags: { team: "platform" },
            attributes: {
              enabled: true,
              exp: Math.floor(expiresOn.getTime() / 1000),
            },
          });
        },
      ]);

      const client = createClient(fetcher, { getAuthorizationHeader });
      const secret = await client.setSecret("app-secret", "secret-value", {
        contentType: "text/plain",
        enabled: true,
        expiresOn,
        tags: { team: "platform" },
      });

      expect(JSON.parse(capturedBody)).toEqual({
        value: "secret-value",
        contentType: "text/plain",
        tags: { team: "platform" },
        attributes: {
          enabled: true,
          exp: Math.floor(expiresOn.getTime() / 1000),
        },
      });
      expect(secret).toMatchObject({
        name: "app-secret",
        value: "secret-value",
        properties: {
          vaultUrl: "https://example.vault.azure.net",
          version: "version-1",
          contentType: "text/plain",
          enabled: true,
          tags: { team: "platform" },
        },
      });
      expect(secret.properties.expiresOn?.toISOString()).toBe(expiresOn.toISOString());
    });
  });

  describe("getSecret", () => {
    test("requests a non-latest explicit version when provided", async () => {
      const fetcher = createFetchMock([
        (url, init) => {
          expect(url).toBe("https://example.vault.azure.net/secrets/app-secret/version-1?api-version=7.6");
          const headers = new Headers(init.headers);
          expect(headers.get("Authorization")).toBe("Bearer token");

          return jsonResponse({
            id: "https://example.vault.azure.net/secrets/app-secret/version-1",
            value: "first-version",
            attributes: {},
          });
        },
      ]);

      const client = createClient(fetcher);
      const secret = await client.getSecret("app-secret", { version: "version-1" });

      expect(secret.value).toBe("first-version");
      expect(secret.properties.version).toBe("version-1");
    });

    test("uses getToken credentials with an explicit version", async () => {
      const getToken = vi.fn(async () => ({
        token: "token-value",
        tokenType: "Bearer" as const,
        expiresOnTimestamp: Date.now() + 60_000,
      }));

      const fetcher = createFetchMock([
        (url, init) => {
          expect(url).toBe("https://example.vault.azure.net/secrets/app-secret/version-2?api-version=7.6");
          const headers = new Headers(init.headers);
          expect(headers.get("Authorization")).toBe("Bearer token-value");

          return jsonResponse({
            id: "https://example.vault.azure.net/secrets/app-secret/version-2",
            value: "version-two",
            attributes: {},
          });
        },
      ]);

      const client = createClient(fetcher, { getToken });
      const secret = await client.getSecret("app-secret", { version: "version-2" });

      expect(getToken).toHaveBeenCalledWith([keyVaultOAuthScope]);
      expect(secret).toMatchObject({
        name: "app-secret",
        value: "version-two",
        properties: {
          version: "version-2",
        },
      });
    });

    test("surfaces Key Vault error details", async () => {
      const fetcher = createFetchMock([
        () =>
          new Response(JSON.stringify({ error: { code: "SecretNotFound", message: "Missing secret" } }), {
            status: 404,
            statusText: "Not Found",
            headers: { "content-type": "application/json" },
          }),
      ]);

      const client = createClient(fetcher);
      const request = client.getSecret("missing-secret");

      await expect(request).rejects.toBeInstanceOf(KeyVaultRequestError);
      await expect(request).rejects.toMatchObject({
        status: 404,
        errorCode: "SecretNotFound",
        message: expect.stringContaining("Missing secret"),
      });
    });
  });

  describe("updateSecretProperties", () => {
    test("updates metadata without sending a value", async () => {
      const fetcher = createFetchMock([
        (url, init) => {
          expect(url).toBe("https://example.vault.azure.net/secrets/app-secret/?api-version=7.6");
          expect(init.method).toBe("PATCH");
          expect(JSON.parse(getBodyString(init.body))).toEqual({
            contentType: "application/json",
            tags: { env: "prod" },
            attributes: {
              enabled: false,
            },
          });

          return jsonResponse({
            id: "https://example.vault.azure.net/secrets/app-secret/version-3",
            contentType: "application/json",
            tags: { env: "prod" },
            attributes: {
              enabled: false,
            },
          });
        },
      ]);

      const client = createClient(fetcher);
      const properties = await client.updateSecretProperties("app-secret", undefined, {
        contentType: "application/json",
        enabled: false,
        tags: { env: "prod" },
      });

      expect(properties).toMatchObject({
        name: "app-secret",
        version: "version-3",
        contentType: "application/json",
        enabled: false,
        tags: { env: "prod" },
      });
    });
  });

  describe("deleteSecret", () => {
    test("returns deleted secret metadata", async () => {
      const fetcher = createLifecycleFetcher();
      const client = createClient(fetcher);

      const deleted = await client.deleteSecret("app-secret");

      expect(deleted.recoveryId).toBe("https://example.vault.azure.net/deletedsecrets/app-secret");
    });
  });

  describe("getDeletedSecret", () => {
    test("parses deleted timestamps", async () => {
      const fetcher = createFetchMock([
        () =>
          jsonResponse({
            id: "https://example.vault.azure.net/deletedsecrets/app-secret/version-1",
            recoveryId: "https://example.vault.azure.net/deletedsecrets/app-secret",
            deletedDate: 1_700_000_000,
            scheduledPurgeDate: 1_700_086_400,
            attributes: {},
          }),
      ]);
      const client = createClient(fetcher);

      const deleted = await client.getDeletedSecret("app-secret");

      expect(deleted.properties.deletedOn).toBeInstanceOf(Date);
      expect(deleted.scheduledPurgeDate).toBeInstanceOf(Date);
    });
  });

  describe("recoverDeletedSecret", () => {
    test("returns the restored secret value", async () => {
      const fetcher = createFetchMock([
        () =>
          jsonResponse({
            id: "https://example.vault.azure.net/secrets/app-secret/version-1",
            value: "restored",
            attributes: {},
          }),
      ]);
      const client = createClient(fetcher);

      const recovered = await client.recoverDeletedSecret("app-secret");

      expect(recovered.value).toBe("restored");
    });
  });

  describe("purgeDeletedSecret", () => {
    test("uses DELETE on the deleted secret path", async () => {
      const requests: Array<{ url: string; method: string | undefined }> = [];
      const fetcher = createFetchMock([
        (url, init) => {
          requests.push({ url, method: init.method });
          return textResponse("", 204, "No Content");
        },
      ]);
      const client = createClient(fetcher);

      await client.purgeDeletedSecret("app-secret");

      expect(requests).toEqual([
        { url: "https://example.vault.azure.net/deletedsecrets/app-secret?api-version=7.6", method: "DELETE" },
      ]);
    });
  });

  describe("listPropertiesOfSecrets", () => {
    test("returns continuationToken from nextLink", async () => {
      const requests: string[] = [];
      const fetcher = createFetchMock([
        (url) => {
          requests.push(url);
          return jsonResponse({
            value: [
              {
                id: "https://example.vault.azure.net/secrets/first/version-a",
                attributes: { enabled: true },
              },
            ],
            nextLink: "https://example.vault.azure.net/secrets?api-version=7.6&maxresults=1&skiptoken=next-page",
          });
        },
        (url) => {
          requests.push(url);
          return jsonResponse({
            value: [
              {
                id: "https://example.vault.azure.net/secrets/second/version-b",
                attributes: {},
              },
            ],
          });
        },
      ]);

      const client = createClient(fetcher);
      const pages: SecretProperties[][] = [];
      const tokens: Array<string | undefined> = [];

      for await (const page of client.listPropertiesOfSecrets().byPage({ maxPageSize: 1 })) {
        pages.push(page.value);
        tokens.push(page.continuationToken);
      }

      expect(requests).toEqual([
        "https://example.vault.azure.net/secrets?maxresults=1&api-version=7.6",
        "https://example.vault.azure.net/secrets?api-version=7.6&maxresults=1&skiptoken=next-page",
      ]);
      expect(tokens).toEqual([
        "https://example.vault.azure.net/secrets?api-version=7.6&maxresults=1&skiptoken=next-page",
        undefined,
      ]);
      expect(pages).toEqual([
        [
          expect.objectContaining({
            name: "first",
            version: "version-a",
            enabled: true,
          }),
        ],
        [
          expect.objectContaining({
            name: "second",
            version: "version-b",
          }),
        ],
      ]);
    });
  });

  describe("listDeletedSecrets", () => {
    test("maps deleted secrets with deletedOn metadata", async () => {
      const fetcher = createFetchMock([
        () =>
          jsonResponse({
            value: [
              {
                id: "https://example.vault.azure.net/deletedsecrets/deleted-secret/version-a",
                recoveryId: "https://example.vault.azure.net/deletedsecrets/deleted-secret",
                deletedDate: 1_700_000_000,
                scheduledPurgeDate: 1_700_086_400,
                attributes: {},
              },
            ],
          }),
      ]);

      const client = createClient(fetcher);
      const deletedSecrets: DeletedSecret[] = [];

      for await (const secret of client.listDeletedSecrets()) {
        deletedSecrets.push(secret);
      }

      expect(deletedSecrets).toHaveLength(1);
      expect(deletedSecrets[0]?.name).toBe("deleted-secret");
      expect(deletedSecrets[0]?.deletedOn).toBeInstanceOf(Date);
    });
  });

  describe("listPropertiesOfSecretVersions", () => {
    test("lists secret versions with maxPageSize", async () => {
      const fetcher = createFetchMock([
        (url) => {
          expect(url).toBe(
            "https://example.vault.azure.net/secrets/versioned-secret/versions?maxresults=2&api-version=7.6",
          );
          return jsonResponse({
            value: [
              {
                id: "https://example.vault.azure.net/secrets/versioned-secret/version-1",
                attributes: {},
              },
              {
                id: "https://example.vault.azure.net/secrets/versioned-secret/version-2",
                attributes: {},
              },
            ],
          });
        },
      ]);

      const client = createClient(fetcher);
      const versions: string[] = [];

      for await (const page of client.listPropertiesOfSecretVersions("versioned-secret").byPage({ maxPageSize: 2 })) {
        versions.push(...page.value.map((item) => item.version ?? ""));
      }

      expect(versions).toEqual(["version-1", "version-2"]);
    });
  });
});

function createClient(
  fetcher: typeof globalThis.fetch,
  credential: Parameters<typeof KeyVaultSecretClient>[1] = { getAuthorizationHeader: async () => "Bearer token" },
): KeyVaultSecretClient {
  return new KeyVaultSecretClient("https://example.vault.azure.net", credential, { fetch: fetcher });
}

function createLifecycleFetcher(): typeof globalThis.fetch {
  return createFetchMock([
    () =>
      jsonResponse({
        id: "https://example.vault.azure.net/secrets/app-secret/version-1",
        recoveryId: "https://example.vault.azure.net/deletedsecrets/app-secret",
        deletedDate: 1_700_000_000,
        scheduledPurgeDate: 1_700_086_400,
        attributes: {},
      }),
  ]);
}
