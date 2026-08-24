import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AppConfigurationClient,
  AppConfigurationRequestError,
  type ConfigurationSetting,
  type ConfigurationSettingPage,
} from "../src/index";
import { createFetchMock } from "./helpers";

describe("AppConfigurationClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("rejects HTTP endpoints and authority hosts during construction", () => {
    const credential = { getAuthorizationHeader: vi.fn(async () => "Bearer token") };
    const fetcher = vi.fn<typeof fetch>();

    expect(() => new AppConfigurationClient("http://example.azconfig.io", credential, { fetch: fetcher })).toThrow(
      "endpoint must use HTTPS",
    );
    expect(
      () =>
        new AppConfigurationClient("https://private.azconfig.local", credential, {
          authorityHost: "http://identity.test",
          fetch: fetcher,
        }),
    ).toThrow("authorityHost must use HTTPS");
    expect(() =>
      AppConfigurationClient.fromConnectionString("Endpoint=http://example.azconfig.io;Id=test;Secret=AQID"),
    ).toThrow("endpoint must use HTTPS");
    expect(credential.getAuthorizationHeader).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("supports HTTPS private-link endpoints with sovereign authority hosts", () => {
    const client = new AppConfigurationClient(
      "https://config.private-link.internal",
      { getAuthorizationHeader: async () => "Bearer token" },
      { authorityHost: "https://login.microsoftonline.us" },
    );

    expect(client.url).toBe("https://config.private-link.internal");
  });

  test("uses the public cloud App Configuration scope for AAD requests", async () => {
    const getAuthorizationHeader = vi.fn(async (scope?: string | string[]) => `Bearer ${scope}`);
    const fetcher = createFetchMock([
      (_url, init) => {
        const headers = new Headers(init.headers);
        expect(headers.get("Authorization")).toBe("Bearer https://appconfig.azure.com/.default");
        return jsonResponse({ key: "plain", value: "value", etag: '"1"' });
      },
    ]);

    const client = new AppConfigurationClient(
      "https://example.azconfig.io",
      { getAuthorizationHeader },
      { fetch: fetcher },
    );
    const setting = await client.getConfigurationSetting("plain");

    expect(getAuthorizationHeader).toHaveBeenCalledWith("https://appconfig.azure.com/.default");
    expect(setting).toMatchObject({ key: "plain", value: "value", etag: '"1"' });
  });

  test("uses a sovereign App Configuration scope based on the endpoint", async () => {
    const getAuthorizationHeader = vi.fn(async () => "Bearer gov-token");
    const fetcher = createFetchMock([() => jsonResponse({ key: "plain", value: "value", etag: '"1"' })]);

    const client = new AppConfigurationClient(
      "https://example.azconfig.azure.us",
      { getAuthorizationHeader },
      { fetch: fetcher },
    );
    await client.getConfigurationSetting("plain");

    expect(getAuthorizationHeader).toHaveBeenCalledWith("https://appconfig.azure.us/.default");
  });

  test("fromConnectionString signs requests with HMAC auth", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T12:00:00.000Z"));

    const importKey = vi.fn(async () => ({}) as CryptoKey);
    const digest = vi.fn(async (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
      expect(new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))).toBe(
        "",
      );
      return new Uint8Array([1, 2, 3]);
    });
    const sign = vi.fn(async (_algorithm: AlgorithmIdentifier, _key: CryptoKey, data: BufferSource) => {
      expect(new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))).toBe(
        "GET\n/kv/app-setting?api-version=2023-11-01&label=dev\nMon, 16 Mar 2026 12:00:00 GMT;example.azconfig.io;AQID",
      );
      return new Uint8Array([4, 5, 6]);
    });

    vi.stubGlobal("crypto", {
      subtle: {
        importKey,
        digest,
        sign,
      } as unknown as SubtleCrypto,
    } as Crypto);

    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe("https://example.azconfig.io/kv/app-setting?api-version=2023-11-01&label=dev");
        const headers = new Headers(init.headers);
        expect(headers.get("x-ms-content-sha256")).toBe("AQID");
        expect(headers.get("Authorization")).toBe(
          "HMAC-SHA256 Credential=test-id&SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=BAUG",
        );
        return jsonResponse({ key: "app-setting", label: "dev", value: "value", etag: '"1"' });
      },
    ]);

    const client = AppConfigurationClient.fromConnectionString(
      "Endpoint=https://example.azconfig.io;Id=test-id;Secret=AQID",
      { fetch: fetcher },
    );

    await client.getConfigurationSetting("app-setting", { label: "dev" });

    expect(importKey).toHaveBeenCalledTimes(1);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  test("setConfigurationSetting applies the configured prefix and label", async () => {
    let capturedBody = "";
    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe("https://example.azconfig.io/kv/app01%3Aplain?api-version=2023-11-01&label=dev");
        expect(init.method).toBe("PUT");
        capturedBody = String(init.body ?? "");
        const headers = new Headers(init.headers);
        expect(headers.get("Content-Type")).toBe("application/vnd.microsoft.appconfig.kv+json");
        expect(headers.get("Accept")).toBe("application/vnd.microsoft.appconfig.kv+json, application/problem+json");

        return jsonResponse({
          key: "app01:plain",
          label: "dev",
          value: "value",
          content_type: "text/plain",
          last_modified: "2026-03-16T12:30:00.000Z",
          locked: true,
          etag: '"etag-1"',
          tags: { env: "dev" },
        });
      },
    ]);

    const client = new AppConfigurationClient(
      "https://example.azconfig.io",
      { getAuthorizationHeader: async () => "Bearer token" },
      { fetch: fetcher, prefix: "app01", label: "dev" },
    );

    const setting = await client.setConfigurationSetting("plain", "value", {
      contentType: "text/plain",
      tags: { env: "dev" },
    });

    expect(JSON.parse(capturedBody)).toEqual({
      key: "app01:plain",
      label: "dev",
      value: "value",
      content_type: "text/plain",
      tags: { env: "dev" },
    });
    expect(setting).toMatchObject({
      key: "plain",
      label: "dev",
      value: "value",
      contentType: "text/plain",
      isReadOnly: true,
      etag: '"etag-1"',
      tags: { env: "dev" },
    });
    expect(setting.lastModified?.toISOString()).toBe("2026-03-16T12:30:00.000Z");
  });

  test("deleteConfigurationSetting returns undefined on a 204 response", async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe("https://example.azconfig.io/kv/plain?api-version=2023-11-01");
        expect(init.method).toBe("DELETE");
        return new Response(null, { status: 204, headers: { "sync-token": "a=MQ==;sn=1" } });
      },
    ]);

    const client = new AppConfigurationClient(
      "https://example.azconfig.io",
      { getAuthorizationHeader: async () => "Bearer token" },
      { fetch: fetcher },
    );

    await expect(client.deleteConfigurationSetting("plain")).resolves.toBeUndefined();
  });

  test("listConfigurationSettings pages by prefix, unlabeled label filter, and continuation token", async () => {
    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe("https://example.azconfig.io/kv?api-version=2023-11-01&key=app01%3A*&label=%00");
        const headers = new Headers(init.headers);
        expect(headers.get("Sync-Token")).toBeNull();

        return new Response(
          JSON.stringify({
            items: [{ key: "app01:one", value: "1", etag: '"one"' }],
            etag: '"page-1"',
            "@nextLink": "https://example.azconfig.io/kv?after=next-token&api-version=2023-11-01&key=app01:*&label=%00",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/vnd.microsoft.appconfig.kvset+json",
              "sync-token": "a=MQ==;sn=1",
            },
          },
        );
      },
      (url, init) => {
        expect(url).toBe(
          "https://example.azconfig.io/kv?after=next-token&api-version=2023-11-01&key=app01%3A*&label=%00",
        );
        const headers = new Headers(init.headers);
        expect(headers.get("Sync-Token")).toBe("a=MQ==");

        return new Response(
          JSON.stringify({
            items: [{ key: "app01:two", value: "2", etag: '"two"' }],
            etag: '"page-2"',
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/vnd.microsoft.appconfig.kvset+json",
            },
          },
        );
      },
    ]);

    const client = new AppConfigurationClient(
      "https://example.azconfig.io",
      { getAuthorizationHeader: async () => "Bearer token" },
      { fetch: fetcher, prefix: "app01", label: null },
    );

    const pages = [] as Array<{ keys: string[]; continuationToken?: string; etag?: string }>;
    for await (const page of client.listConfigurationSettings().byPage()) {
      pages.push({
        keys: page.value.map((item: ConfigurationSetting) => item.key),
        continuationToken: page.continuationToken,
        etag: page.etag,
      });
    }

    expect(pages).toEqual([
      {
        keys: ["one"],
        continuationToken: "next-token",
        etag: '"page-1"',
      },
      {
        keys: ["two"],
        continuationToken: undefined,
        etag: '"page-2"',
      },
    ]);
  });

  test("retains and merges the highest sync token sequence for each ID", async () => {
    const response = (syncToken?: string) =>
      new Response(JSON.stringify({ key: "plain", value: "value", etag: '"1"' }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(syncToken !== undefined ? { "sync-token": syncToken } : {}),
        },
      });
    const expectedRequestTokens = [
      null,
      "a=MQ==,b=Mg==",
      "a=MQ==,b=Mg==",
      "a=aGlnaA==,b=Mg==,c=Mw==",
      "a=aGlnaA==,b=Mg==,c=Mw==",
      "a=aGlnaA==,b=Mg==,c=Mw==",
    ];
    const responseTokens = [
      "a=MQ==;sn=5,b=Mg==;sn=2",
      "a=bG93;sn=4,b=ZXF1YWw=;sn=2",
      "a=aGlnaA==;sn=6,c=Mw==;sn=1",
      "",
      undefined,
      undefined,
    ];
    const fetcher = createFetchMock(
      responseTokens.map((syncToken, index) => (_url, init) => {
        expect(new Headers(init.headers).get("Sync-Token")).toBe(expectedRequestTokens[index]);
        return response(syncToken);
      }),
    );
    const client = new AppConfigurationClient(
      "https://example.azconfig.io",
      { getAuthorizationHeader: async () => "Bearer token" },
      { fetch: fetcher },
    );

    for (const _ of responseTokens) {
      await client.getConfigurationSetting("plain");
    }
  });

  test("listConfigurationSettings escapes reserved characters in generated prefix and label filters", async () => {
    const fetcher = createFetchMock([
      (url) => {
        expect(url).toBe(
          "https://example.azconfig.io/kv?api-version=2023-11-01&key=TestApp%3AWeb%5C%2CBlue%5C*%5C%5CTitles%3A*&label=Prod%5C%2CEU%5C*%5C%5C",
        );

        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: {
            "content-type": "application/vnd.microsoft.appconfig.kvset+json",
          },
        });
      },
    ]);

    const client = new AppConfigurationClient(
      "https://example.azconfig.io",
      { getAuthorizationHeader: async () => "Bearer token" },
      {
        fetch: fetcher,
        prefix: "TestApp:Web,Blue*\\Titles",
        label: "Prod,EU*\\",
      },
    );

    const pages = [] as ConfigurationSettingPage[];
    for await (const page of client.listConfigurationSettings().byPage()) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
  });

  test("setConfigurationSetting encodes special key characters and preserves unicode content", async () => {
    const key = "Titles/Welcome, Draft*\\日本語";
    const value = "Line 1\nGrüße 🚀";
    let capturedBody = "";

    const fetcher = createFetchMock([
      (url, init) => {
        expect(url).toBe(
          "https://example.azconfig.io/kv/TestApp%3AService1%3ATitles%2FWelcome%2C%20Draft*%5C%E6%97%A5%E6%9C%AC%E8%AA%9E?api-version=2023-11-01&label=Production",
        );
        capturedBody = String(init.body ?? "");

        return jsonResponse({
          key: `TestApp:Service1:${key}`,
          label: "Production",
          value,
          content_type: "text/plain;charset=utf-8",
          etag: '"encoded"',
        });
      },
    ]);

    const client = new AppConfigurationClient(
      "https://example.azconfig.io",
      { getAuthorizationHeader: async () => "Bearer token" },
      { fetch: fetcher, prefix: "TestApp:Service1", label: "Production" },
    );

    const setting = await client.setConfigurationSetting(key, value, {
      contentType: "text/plain;charset=utf-8",
    });

    expect(JSON.parse(capturedBody)).toEqual({
      key: `TestApp:Service1:${key}`,
      label: "Production",
      value,
      content_type: "text/plain;charset=utf-8",
    });
    expect(setting).toMatchObject({
      key,
      label: "Production",
      value,
      contentType: "text/plain;charset=utf-8",
      etag: '"encoded"',
    });
  });

  test("getConfigurationSetting forwards accept datetime and selected fields", async () => {
    const fetcher = createFetchMock([
      (url) => {
        expect(url).toBe(
          "https://example.azconfig.io/kv/plain?%24select=key%2Clabel%2Clast_modified&api-version=2023-11-01&label=dev",
        );
        return jsonResponse({ key: "plain", label: "dev", etag: '"1"' });
      },
    ]);

    const client = new AppConfigurationClient(
      "https://example.azconfig.io",
      { getAuthorizationHeader: async () => "Bearer token" },
      { fetch: fetcher },
    );

    await client.getConfigurationSetting("plain", {
      label: "dev",
      acceptDateTime: new Date("2026-03-16T12:00:00.000Z"),
      fields: ["key", "label", "lastModified"],
    });
  });

  test("surfaces App Configuration error details", async () => {
    const fetcher = createFetchMock([
      () =>
        new Response(
          JSON.stringify({
            title: "Not Found",
            name: "ResourceNotFound",
            detail: "The requested key was not found.",
            status: 404,
          }),
          {
            status: 404,
            statusText: "Not Found",
            headers: { "content-type": "application/problem+json" },
          },
        ),
    ]);

    const client = new AppConfigurationClient(
      "https://example.azconfig.io",
      { getAuthorizationHeader: async () => "Bearer token" },
      { fetch: fetcher },
    );

    const request = client.getConfigurationSetting("missing");

    await expect(request).rejects.toBeInstanceOf(AppConfigurationRequestError);
    await expect(request).rejects.toMatchObject({
      status: 404,
      errorCode: "ResourceNotFound",
      message: expect.stringContaining("The requested key was not found."),
    });
  });
});

describe("root export", () => {
  test("exports AppConfigurationClient from the main entrypoint", async () => {
    const rootModule = await import("../src/index");
    expect(rootModule.AppConfigurationClient).toBe(AppConfigurationClient);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}
