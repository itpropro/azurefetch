import type { AccessToken } from "../types";

export interface OAuthTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  expires_on?: unknown;
  refresh_on?: unknown;
}

export function parseNumericTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return value;
    }

    return value * 1000;
  }

  if (typeof value === "string") {
    if (value.length === 0) {
      return undefined;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      if (value.includes(".")) {
        return undefined;
      }

      if (numeric > 1_000_000_000_000) {
        return numeric;
      }

      return numeric * 1000;
    }

    const date = Date.parse(value);
    if (!Number.isNaN(date)) {
      return date;
    }
  }

  return undefined;
}

export function parseRefreshTimestamp(value: unknown): number | undefined {
  return parseNumericTimestamp(value);
}

export function parseExpiresTimestamp(response: OAuthTokenResponse, now = Date.now()): number | undefined {
  if (response.expires_on != null) {
    const parsed = parseNumericTimestamp(response.expires_on);
    if (parsed != null) {
      return parsed;
    }
  }

  if (typeof response.expires_in === "number" && Number.isFinite(response.expires_in)) {
    return now + response.expires_in * 1000;
  }

  if (typeof response.expires_in === "string" && response.expires_in.length > 0) {
    const seconds = Number(response.expires_in);
    if (Number.isFinite(seconds)) {
      return now + seconds * 1000;
    }
  }

  return undefined;
}

export function normalizeToken(response: unknown, now = Date.now()): AccessToken {
  if (response == null || typeof response !== "object") {
    throw new TypeError("Token response must be an object");
  }

  const payload = response as OAuthTokenResponse;
  const accessToken = payload.access_token;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new TypeError("Missing access_token");
  }

  const expiresOnTimestamp = parseExpiresTimestamp(payload, now);

  if (expiresOnTimestamp == null || Number.isNaN(expiresOnTimestamp)) {
    throw new TypeError("Unable to parse token expiration");
  }

  return {
    token: accessToken,
    tokenType: "Bearer",
    expiresOnTimestamp,
    refreshAfterTimestamp: parseRefreshTimestamp(payload.refresh_on),
  };
}
