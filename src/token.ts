import type { AccessToken, TokenReuseOptions } from "./types";

const DEFAULT_REFRESH_SKEW_MS = 300_000;

export function shouldRefreshToken(token: AccessToken, options?: TokenReuseOptions): boolean {
  const now = options?.now ?? Date.now();
  const refreshSkewMs = options?.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;

  if (token.refreshAfterTimestamp != null && now >= token.refreshAfterTimestamp) {
    return true;
  }

  return now >= token.expiresOnTimestamp - refreshSkewMs;
}

export function getAuthorizationHeader(token: AccessToken): string {
  return `Bearer ${token.token}`;
}
