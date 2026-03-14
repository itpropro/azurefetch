import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { TokenUnavailableError } from "../src/errors";
import { getManagedIdentityToken } from "../src/managed-identity";
import { captureEnv, createFetchMock, getBodyString, jsonResponse, restoreEnv } from "./helpers";

describe("getManagedIdentityToken", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = captureEnv();
  });

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  test("rejects missing or non-default scope", async () => {
    const fetchMock = createFetchMock([]);
    await expect(
      getManagedIdentityToken({
        scope: "https://vault.azure.net",
        fetch: fetchMock,
      }),
    ).rejects.toThrow("Scope must end with /.default");

    await expect(
      getManagedIdentityToken({
        scope: "https://vault.azure.net/.default https://graph.microsoft.com/.default",
        fetch: fetchMock,
      }),
    ).rejects.toThrow("Managed identity requires exactly one scope");
  });

  test("rejects conflicting selector values", async () => {
    const fetchMock = createFetchMock([]);

    await expect(
      getManagedIdentityToken({
        scope: "https://vault.azure.net/.default",
        clientId: "client",
        objectId: "obj",
        fetch: fetchMock,
      }),
    ).rejects.toThrow("Specify at most one of clientId, objectId, or resourceId");

    await expect(
      getManagedIdentityToken({
        scope: "https://vault.azure.net/.default",
        clientId: "client",
        resourceId: "res",
        fetch: fetchMock,
      }),
    ).rejects.toThrow("Specify at most one of clientId, objectId, or resourceId");
  });

  test("requests app-service token with query and headers", async () => {
    process.env.IDENTITY_ENDPOINT = "https://appservice.azurewebsites.net/identity";
    process.env.IDENTITY_HEADER = "app-header-token";

    let capturedRequestUrl: URL | undefined;
    let capturedHeaders: Headers | undefined;

    const fetchMock = createFetchMock([
      (url, init) => {
        capturedRequestUrl = new URL(url);
        capturedHeaders = new Headers(init.headers);

        return jsonResponse({
          access_token: "app-token",
          expires_in: 600,
        });
      },
    ]);

    const token = await getManagedIdentityToken({
      scope: "https://vault.azure.net/.default",
      clientId: "my-client",
      fetch: fetchMock,
    });

    expect(capturedRequestUrl?.origin).toBe("https://appservice.azurewebsites.net");
    expect(capturedRequestUrl?.pathname).toBe("/identity");
    expect(capturedRequestUrl?.searchParams.get("api-version")).toBe("2019-08-01");
    expect(capturedRequestUrl?.searchParams.get("resource")).toBe("https://vault.azure.net");
    expect(capturedRequestUrl?.searchParams.get("client_id")).toBe("my-client");
    expect(capturedHeaders?.get("Metadata")).toBe("true");
    expect(capturedHeaders?.get("X-IDENTITY-HEADER")).toBe("app-header-token");

    expect(token).toMatchObject({
      token: "app-token",
      tokenType: "Bearer",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("requests cloud shell token via form POST and rejects explicit selectors", async () => {
    process.env.MSI_ENDPOINT = "http://localhost:8080/msi/token";
    process.env.MSI_SECRET = "ignored";

    await expect(
      getManagedIdentityToken({
        scope: "https://vault.azure.net/.default",
        clientId: "my-client",
        fetch: createFetchMock([]),
      }),
    ).rejects.toBeInstanceOf(TokenUnavailableError);

    let capturedHeaders: Headers | undefined;
    let capturedBody: string | undefined;

    const fetchMock = createFetchMock([
      (url, init) => {
        capturedHeaders = new Headers(init.headers);
        capturedBody = getBodyString(init.body);

        expect(url).toBe("http://localhost:8080/msi/token");
        expect(init.method).toBe("POST");

        return jsonResponse({
          access_token: "cloud-token",
          expires_on: 1234,
        });
      },
    ]);

    const token = await getManagedIdentityToken({
      scope: "https://vault.azure.net/.default",
      fetch: fetchMock,
    });

    const body = new URLSearchParams(capturedBody);

    expect(capturedHeaders?.get("Metadata")).toBe("true");
    expect(capturedHeaders?.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(body.get("resource")).toBe("https://vault.azure.net");
    expect(body.get("api-version")).toBe("2017-09-01");

    expect(token.token).toBe("cloud-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("queries IMDS after a successful probe", async () => {
    let probeRequestUrl: URL | undefined;
    let probeHeaders: Headers | undefined;
    let tokenRequestUrl: URL | undefined;

    const fetchMock = createFetchMock([
      (url, init) => {
        probeRequestUrl = new URL(url);
        probeHeaders = new Headers(init.headers);

        return jsonResponse({ probe: true });
      },
      (url) => {
        tokenRequestUrl = new URL(url);

        return jsonResponse({
          access_token: "imds-token",
          expires_on: 1234,
        });
      },
    ]);

    process.env.AZURE_POD_IDENTITY_AUTHORITY_HOST = "http://169.254.169.254";

    const token = await getManagedIdentityToken({
      scope: "https://vault.azure.net/.default",
      objectId: "object-1",
      fetch: fetchMock,
    });

    expect(probeRequestUrl?.pathname).toBe("/metadata/identity/oauth2/token");
    expect(probeRequestUrl?.searchParams.get("api-version")).toBe("2018-02-01");
    expect(probeRequestUrl?.searchParams.get("resource")).toBeNull();
    expect(probeHeaders?.get("Metadata")).toBe("true");

    expect(tokenRequestUrl?.searchParams.get("api-version")).toBe("2018-02-01");
    expect(tokenRequestUrl?.searchParams.get("resource")).toBe("https://vault.azure.net");

    expect(token.token).toBe("imds-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("throws token unavailable on IMDS probe failure", async () => {
    const fetchMock = createFetchMock([
      () =>
        new Response("", {
          status: 500,
          statusText: "boom",
        }),
    ]);

    await expect(
      getManagedIdentityToken({
        scope: "https://vault.azure.net/.default",
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(TokenUnavailableError);
  });

  test("translates endpoint token errors", async () => {
    process.env.MSI_ENDPOINT = "http://localhost:8080/msi/token";

    const fetchMock = createFetchMock([
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_resource",
            },
            error_description: "bad",
          }),
          {
            status: 400,
            statusText: "Bad",
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    ]);

    await expect(
      getManagedIdentityToken({
        scope: "https://vault.azure.net/.default",
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({
      name: "TokenRequestError",
      status: 400,
      errorCode: "invalid_resource",
    });
  });

  test("rejects malformed token response", async () => {
    const fetchMock = createFetchMock([
      () =>
        jsonResponse({
          token: "missing",
          refresh_on: "2024-01-01T00:00:00Z",
        }),
    ]);

    process.env.MSI_ENDPOINT = "http://localhost:8080/msi/token";

    await expect(
      getManagedIdentityToken({
        scope: "https://vault.azure.net/.default",
        fetch: fetchMock,
      }),
    ).rejects.toThrow("Missing access_token");
  });
});
