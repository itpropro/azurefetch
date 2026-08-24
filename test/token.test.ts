import { describe, expect, expectTypeOf, test } from "vitest";

import { getAuthorizationHeader, shouldRefreshToken } from "../src/token";
import type { AccessToken } from "../src/types";

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

describe("AccessToken authorization", () => {
  test("accepts the standard token shape without tokenType", () => {
    const token: AccessToken = {
      token: "standard-token",
      expiresOnTimestamp: Date.now() + 60_000,
    };

    expectTypeOf(token.tokenType).toEqualTypeOf<"Bearer" | "pop" | undefined>();
    expect(getAuthorizationHeader(token)).toBe("Bearer standard-token");
  });

  test.each([
    { tokenType: "Bearer" as const, expected: "Bearer explicit-token" },
    { tokenType: "pop" as const, expected: "pop explicit-token" },
  ])("serializes $tokenType tokens", ({ tokenType, expected }) => {
    expect(
      getAuthorizationHeader({
        token: "explicit-token",
        tokenType,
        expiresOnTimestamp: Date.now() + 60_000,
      }),
    ).toBe(expected);
  });
});
