import { afterEach, describe, expect, test, vi } from "vitest";

import { createTokenProvider } from "../src/provider";

describe("createTokenProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("returns cached token while valid", async () => {
    const now = Date.now();
    const token = {
      token: "cached",
      tokenType: "Bearer" as const,
      expiresOnTimestamp: now + 600_000,
    };

    const loadToken = vi.fn(async () => token);
    const provider = createTokenProvider({ loadToken });

    const first = await provider.getToken();
    const second = await provider.getToken();

    expect(loadToken).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  test("refreshes stale tokens and prefers refreshAfterTimestamp", async () => {
    const stale = {
      token: "old",
      tokenType: "Bearer" as const,
      expiresOnTimestamp: Date.now() + 5_000,
      refreshAfterTimestamp: Date.now() - 1,
    };

    const fresh = {
      token: "fresh",
      tokenType: "Bearer" as const,
      expiresOnTimestamp: Date.now() + 5_000,
    };

    const loadToken = vi.fn(async () => fresh).mockImplementationOnce(async () => stale);
    const provider = createTokenProvider({ loadToken });

    const first = await provider.getToken();
    const second = await provider.getToken();

    expect(loadToken).toHaveBeenCalledTimes(2);
    expect(first.token).toBe("old");
    expect(second.token).toBe("fresh");
  });

  test("deduplicates concurrent loads", async () => {
    let resolveToken: (value: { token: string; tokenType: "Bearer"; expiresOnTimestamp: number }) => void;
    const loadPromise = new Promise<{ token: string; tokenType: "Bearer"; expiresOnTimestamp: number }>((resolve) => {
      resolveToken = resolve;
    });

    const loadToken = vi.fn(async () => {
      return loadPromise;
    });

    const provider = createTokenProvider({ loadToken });
    const first = provider.getToken();
    const second = provider.getToken();

    resolveToken!({
      token: "deduped",
      tokenType: "Bearer",
      expiresOnTimestamp: Date.now() + 10_000,
    });

    const [a, b] = await Promise.all([first, second]);

    expect(loadToken).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  test("removes failed in-flight requests from cache", async () => {
    const loadToken = vi.fn<() => Promise<{ token: string; tokenType: "Bearer"; expiresOnTimestamp: number }>>();
    loadToken
      .mockRejectedValueOnce(new Error("first-failure"))
      .mockResolvedValueOnce({ token: "retry", tokenType: "Bearer", expiresOnTimestamp: Date.now() + 10_000 });

    const provider = createTokenProvider({ loadToken });

    await expect(provider.getToken()).rejects.toThrow("first-failure");

    const token = await provider.getToken();

    expect(loadToken).toHaveBeenCalledTimes(2);
    expect(token.token).toBe("retry");
  });

  test("uses provided cache and cache key", async () => {
    const cache = new Map<string, { token: string; tokenType: "Bearer"; expiresOnTimestamp: number }>();
    const provider = createTokenProvider({
      loadToken: async () => ({
        token: "value",
        tokenType: "Bearer",
        expiresOnTimestamp: Date.now() + 10_000,
      }),
      cache,
      cacheKey: "shared-key",
    });

    await provider.getToken();

    expect(cache.has("shared-key")).toBe(true);
    expect(cache.has("__azurefetch-token-provider-default")).toBe(false);
  });
});
