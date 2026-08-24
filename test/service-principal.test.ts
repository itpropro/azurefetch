import { describe, expect, test, vi } from "vitest";

import { getServicePrincipalToken } from "../src/service-principal";
import { createFetchMock, getBodyString, jsonResponse } from "./helpers";

describe("getServicePrincipalToken", () => {
  test("rejects an HTTP authority before token acquisition", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      getServicePrincipalToken({
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
        scope: "scope/.default",
        authorityHost: "http://identity.test",
        fetch: fetcher,
      }),
    ).rejects.toThrow("authorityHost must use HTTPS");

    expect(fetcher).not.toHaveBeenCalled();
  });

  test("validates tenant, client, and client secret", async () => {
    const fetchMock = createFetchMock([() => jsonResponse({ access_token: "x", expires_in: 3600 })]);

    await expect(
      getServicePrincipalToken({
        tenantId: "",
        clientId: "client",
        clientSecret: "secret",
        scope: "scope",
        fetch: fetchMock,
      }),
    ).rejects.toThrow("tenantId is required");

    await expect(
      getServicePrincipalToken({
        tenantId: "tenant",
        clientId: "",
        clientSecret: "secret",
        scope: "scope",
        fetch: fetchMock,
      }),
    ).rejects.toThrow("clientId is required");

    await expect(
      getServicePrincipalToken({
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "",
        scope: "scope",
        fetch: fetchMock,
      }),
    ).rejects.toThrow("clientSecret is required");

    await expect(
      getServicePrincipalToken({
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
        scope: [],
        fetch: fetchMock,
      }),
    ).rejects.toThrow("At least one non-empty scope is required");
  });

  test("posts form body to default authority host", async () => {
    const fetchMock = createFetchMock([
      (url, init) => {
        const form = new URLSearchParams(getBodyString(init?.body));
        expect(url).toBe("https://login.microsoftonline.com/my-tenant/oauth2/v2.0/token");
        expect(init?.method).toBe("POST");
        expect(form.get("client_id")).toBe("client");
        expect(form.get("client_secret")).toBe("secret");
        expect(form.get("grant_type")).toBe("client_credentials");
        expect(form.get("scope")).toBe("https://vault.azure.net/.default https://graph.microsoft.com/.default");

        return jsonResponse({
          access_token: "svc-token",
          expires_in: 3600,
        });
      },
    ]);

    const token = await getServicePrincipalToken({
      tenantId: "my-tenant",
      clientId: "client",
      clientSecret: "secret",
      scope: ["https://vault.azure.net/.default", "https://graph.microsoft.com/.default"],
      fetch: fetchMock,
    });

    expect(token).toMatchObject({
      token: "svc-token",
      tokenType: "Bearer",
    });
  });

  test("supports custom authority host and exposes oauth errors", async () => {
    const fetchMock = createFetchMock([
      (url, init) => {
        const body = new URLSearchParams(getBodyString(init?.body));
        expect(url).toBe("https://identity.test/v2.0/my-tenant/oauth2/v2.0/token");
        expect(body.get("scope")).toBe("scope/.default");

        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_client",
            },
            error_description: "bad request",
          }),
          {
            status: 401,
            statusText: "Unauthorized",
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    ]);

    await expect(
      getServicePrincipalToken({
        tenantId: "my-tenant",
        clientId: "client",
        clientSecret: "secret",
        scope: "scope/.default",
        authorityHost: "https://identity.test/v2.0",
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({
      name: "TokenRequestError",
      status: 401,
      errorCode: "invalid_client",
    });
  });

  test("rejects malformed OAuth response", async () => {
    const fetchMock = createFetchMock([
      () =>
        jsonResponse({
          access_token: "",
          expires_in: "3600",
        }),
    ]);

    await expect(
      getServicePrincipalToken({
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
        scope: "scope",
        fetch: fetchMock,
      }),
    ).rejects.toThrow(TypeError);
  });
});
