import { createTokenProvider } from "./provider";
import { getDefaultAzureCredentialToken } from "./default-credential";
import type { AccessToken, TokenProvider } from "./types";
import { resolveRequiredScopes, storageOAuthScope } from "./internal/request-core";
import { sanitizeAuthorityHost } from "./internal/url";

export interface DefaultAzureCredentialOptions {
  authorityHost?: string;
  managedIdentityClientId?: string;
  fetch?: typeof globalThis.fetch;
}

export class DefaultAzureCredential {
  private readonly providers = new Map<string, TokenProvider>();

  private readonly options: DefaultAzureCredentialOptions;

  constructor(options: DefaultAzureCredentialOptions = {}) {
    this.options = {
      ...options,
      authorityHost: options.authorityHost == null ? undefined : sanitizeAuthorityHost(options.authorityHost),
    };
  }

  private getTokenProvider(scopes: string[]): TokenProvider {
    const cacheKey = JSON.stringify(scopes);
    const existingProvider = this.providers.get(cacheKey);
    if (existingProvider != null) {
      return existingProvider;
    }

    const provider = createTokenProvider({
      loadToken: async () =>
        getDefaultAzureCredentialToken({
          scope: scopes.length === 1 ? scopes[0] : scopes,
          fetch: this.options.fetch,
          authorityHost: this.options.authorityHost,
          managedIdentityClientId: this.options.managedIdentityClientId,
        }),
    });

    this.providers.set(cacheKey, provider);
    return provider;
  }

  public async getToken(scopes: string | string[]): Promise<AccessToken> {
    const normalizedScopes = resolveRequiredScopes(scopes);
    const provider = this.getTokenProvider(normalizedScopes);
    return provider.getToken();
  }

  public async getAuthorizationHeader(scopes: string | string[] = storageOAuthScope): Promise<string> {
    const normalizedScopes = resolveRequiredScopes(scopes);
    const token = await this.getToken(normalizedScopes);
    return `${token.tokenType ?? "Bearer"} ${token.token}`;
  }
}
