import { afterEach, describe, expect, test, vi } from "vitest";

import { AzureClient } from "../src/client";
import { BlobServiceClient } from "../src/blob";
import { DefaultAzureCredential } from "../src/default-azure-credential";
import { TableServiceClient } from "../src/table";
import * as defaultCredential from "../src/default-credential";
import { textResponse } from "./helpers";

describe("AzureClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("uses the default scope for token credential fallback", async () => {
    const getToken = vi.fn(async () => ({
      token: "token-value",
      tokenType: "Bearer" as const,
      expiresOnTimestamp: Date.now() + 60_000,
    }));

    const request = await new AzureClient({ credential: { getToken } }).sign("https://example.com");

    expect(request.headers.get("Authorization")).toBe("Bearer token-value");
    expect(getToken).toHaveBeenCalledWith(["https://storage.azure.com/.default"]);
  });

  test("prefers getAuthorizationHeader over getToken on mixed credentials", async () => {
    const getAuthorizationHeader = vi.fn(async () => "Bearer header-token");
    const getToken = vi.fn(async () => ({
      token: "token-value",
      tokenType: "Bearer" as const,
      expiresOnTimestamp: Date.now() + 60_000,
    }));

    const request = await new AzureClient({ credential: { getAuthorizationHeader, getToken } }).sign(
      "https://example.com",
    );

    expect(request.headers.get("Authorization")).toBe("Bearer header-token");
    expect(getAuthorizationHeader).toHaveBeenCalledTimes(1);
    expect(getToken).not.toHaveBeenCalled();
  });

  test("supports per-request credential and scope overrides", async () => {
    const defaultCredential = { getAuthorizationHeader: vi.fn(async () => "Bearer default") };
    const overrideCredential = { getAuthorizationHeader: vi.fn(async () => "Bearer override") };

    const request = await new AzureClient({ credential: defaultCredential }).sign("https://example.com", {
      azure: {
        credential: overrideCredential,
        scope: "https://graph.microsoft.com/.default",
      },
    });

    expect(defaultCredential.getAuthorizationHeader).not.toHaveBeenCalled();
    expect(overrideCredential.getAuthorizationHeader).toHaveBeenCalledWith("https://graph.microsoft.com/.default");
    expect(request.headers.get("Authorization")).toBe("Bearer override");
  });

  test("falls back to getDefaultAzureCredentialToken with per-request authority host", async () => {
    const providerSpy = vi.spyOn(defaultCredential, "getDefaultAzureCredentialToken").mockResolvedValue({
      token: "provider-token",
      tokenType: "Bearer" as const,
      expiresOnTimestamp: Date.now() + 60_000,
    });

    const { AzureClient: RootAzureClient } = await import("../src/index");

    const request = await new RootAzureClient({
      scope: "https://storage.azure.com/.default",
      authorityHost: "https://login.default.test",
    }).sign("https://example.com", {
      azure: {
        scope: ["https://graph.microsoft.com/.default"],
        authorityHost: "https://login.override.test",
      },
    });

    expect(request.headers.get("Authorization")).toBe("Bearer provider-token");
    const [input] = providerSpy.mock.calls;
    expect(input?.[0]).toMatchObject({
      scope: "https://graph.microsoft.com/.default",
      authorityHost: "https://login.override.test",
      fetch: expect.any(Function),
    });
  });

  test("fetch() returns a fetch response with signed request", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (input instanceof Request) {
        expect(input.headers.get("Authorization")).toBe("Bearer token-value");
        expect(input.method).toBe("POST");
      }

      return textResponse("", 204);
    });

    const requestCredential = {
      getToken: vi.fn(async () => ({
        token: "token-value",
        tokenType: "Bearer" as const,
        expiresOnTimestamp: Date.now() + 60_000,
      })),
    };

    const response = await new AzureClient({
      credential: requestCredential,
      fetch: fetchSpy,
    }).fetch("https://example.com", {
      method: "POST",
      azure: {
        scope: "https://graph.microsoft.com/.default",
      },
    });

    expect(response.status).toBe(204);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("AzureClient.sign works with DefaultAzureCredential", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      return textResponse("", 200, "OK", {
        "x-test": (init.headers instanceof Headers ? init.headers.get("x-test") || "" : "") as string,
      });
    });
    const credential = new DefaultAzureCredential();
    const authSpy = vi.spyOn(credential, "getAuthorizationHeader").mockResolvedValue("Bearer default");

    const client = new AzureClient({ credential, fetch: fetcher });

    await client.sign("https://graph.microsoft.com", {
      azure: {
        scope: "https://graph.microsoft.com/.default",
      },
    });

    expect(fetcher).toHaveBeenCalledTimes(0);
    expect(authSpy).toHaveBeenCalledTimes(1);
  });

  test("BlobServiceClient uses DefaultAzureCredential authorization headers", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      return textResponse("", 200, "OK", {
        "x-test": (init.headers instanceof Headers ? init.headers.get("x-test") || "" : "") as string,
      });
    });
    const credential = new DefaultAzureCredential();
    const authSpy = vi.spyOn(credential, "getAuthorizationHeader").mockResolvedValue("Bearer default");
    const blobClient = new BlobServiceClient("https://myaccount.blob.core.windows.net", credential, { fetch: fetcher });

    await blobClient.getContainerClient("container").createIfNotExists();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(authSpy).toHaveBeenCalledTimes(1);
    const blobAuth = new Headers(fetcher.mock.calls[0]?.[1]?.headers as HeadersInit);
    expect(blobAuth.get("Authorization")).toBe("Bearer default");
  });

  test("TableServiceClient uses DefaultAzureCredential authorization headers", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      return textResponse("", 200, "OK", {
        "x-test": (init.headers instanceof Headers ? init.headers.get("x-test") || "" : "") as string,
      });
    });
    const credential = new DefaultAzureCredential();
    const authSpy = vi.spyOn(credential, "getAuthorizationHeader").mockResolvedValue("Bearer default");
    const tableClient = new TableServiceClient("https://myaccount.table.core.windows.net", credential, {
      fetch: fetcher,
    });

    await tableClient.request("GET", "https://myaccount.table.core.windows.net/Tables");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(authSpy).toHaveBeenCalledTimes(1);
    const tableAuth = new Headers(fetcher.mock.calls[0]?.[1]?.headers as HeadersInit);
    expect(tableAuth.get("Authorization")).toBe("Bearer default");
  });
});
