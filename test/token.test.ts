import { describe, expect, test } from "vitest";

import { shouldRefreshToken } from "../src/token";

describe("shouldRefreshToken", () => {
  test("uses refreshAfterTimestamp when present", () => {
    const now = Date.now();
    const token = {
      token: "t",
      tokenType: "Bearer" as const,
      expiresOnTimestamp: now + 60 * 60 * 1000,
      refreshAfterTimestamp: now - 100,
    };

    expect(shouldRefreshToken(token, { now })).toBe(true);
  });

  test("uses expiry minus skew when refreshAfterTimestamp is absent", () => {
    const now = Date.now();
    const token = {
      token: "t",
      tokenType: "Bearer" as const,
      expiresOnTimestamp: now + 60_000,
    };

    expect(shouldRefreshToken(token, { now, refreshSkewMs: 30_000 })).toBe(false);
    expect(shouldRefreshToken(token, { now: now + 31_000, refreshSkewMs: 30_000 })).toBe(true);
  });
});
