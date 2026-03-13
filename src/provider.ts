import type { AccessToken, TokenProvider } from "./types";
import { getAuthorizationHeader, shouldRefreshToken } from "./token";

interface CreateTokenProviderOptions {
  loadToken: () => Promise<AccessToken>;
  cache?: Map<string, AccessToken | Promise<AccessToken>>;
  cacheKey?: string;
  refreshSkewMs?: number;
}

const INTERNAL_PROVIDER_CACHE_KEY = "__azurefetch-token-provider-default";

export function createTokenProvider(options: CreateTokenProviderOptions): TokenProvider {
  const cache = options.cache ?? new Map<string, AccessToken | Promise<AccessToken>>();
  const cacheKey = options.cacheKey ?? INTERNAL_PROVIDER_CACHE_KEY;
  const refreshSkewMs = options.refreshSkewMs;

  async function loadAndCacheToken(): Promise<AccessToken> {
    const loadPromise = options.loadToken();
    cache.set(cacheKey, loadPromise);

    try {
      const token = await loadPromise;
      cache.set(cacheKey, token);
      return token;
    } catch (error) {
      cache.delete(cacheKey);
      throw error;
    }
  }

  async function getToken(): Promise<AccessToken> {
    const cached = cache.get(cacheKey);

    if (cached instanceof Promise) {
      return cached;
    }

    if (cached && !shouldRefreshToken(cached, { refreshSkewMs })) {
      return cached;
    }

    return loadAndCacheToken();
  }

  return {
    async getToken() {
      return getToken();
    },
    async getAuthorizationHeader() {
      const token = await getToken();
      return getAuthorizationHeader(token);
    },
  };
}

export { TokenProvider };
