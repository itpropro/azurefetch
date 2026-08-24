import { loadDefaultToken } from "./default-token-loader";
import { createTokenProvider } from "../provider";
import type { AccessToken, TokenProvider } from "../types";

export const storageOAuthScope = "https://storage.azure.com/.default";
export const keyVaultOAuthScope = "https://vault.azure.net/.default";
export const appConfigurationOAuthScope = "https://appconfig.azure.com/.default";

interface HeaderCredential {
  getAuthorizationHeader(scope?: string | string[]): Promise<string>;
}

interface TokenCredential {
  getToken(scopes: string | string[]): Promise<AccessToken | null>;
}

export type AzureRequestCredential = HeaderCredential | TokenCredential;

export interface ResolveAuthorizationInput {
  credential?: AzureRequestCredential;
  scope?: string | string[];
  authorityHost?: string;
  fetch: typeof globalThis.fetch;
  defaultScope?: string | string[];
  defaultAuthorityHost?: string;
  tokenProviders?: Map<string, TokenProvider>;
}

export function resolveAuthorizationScopes(scope?: string | string[]): string[] {
  const values = (Array.isArray(scope) ? scope : [scope]).filter((value): value is string => typeof value === "string");
  if (values.length === 0) {
    return [storageOAuthScope];
  }

  const scopes = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (scopes.length === 0) {
    return [storageOAuthScope];
  }

  return scopes;
}

export function resolveRequiredScopes(scope: string | string[]): string[] {
  const values = Array.isArray(scope) ? scope : [scope];
  const scopes = values.map((value) => value.trim()).filter((value) => value.length > 0);

  if (scopes.length === 0) {
    throw new TypeError("At least one non-empty scope is required");
  }

  return scopes;
}

export function hasAuthorizationHeaderCredential(
  credential: AzureRequestCredential | undefined,
): credential is HeaderCredential {
  return (
    credential != null &&
    "getAuthorizationHeader" in credential &&
    typeof credential.getAuthorizationHeader === "function"
  );
}

export function hasTokenCredential(credential: AzureRequestCredential | undefined): credential is TokenCredential {
  return credential != null && "getToken" in credential && typeof credential.getToken === "function";
}

export async function resolveAuthorizationHeader(input: ResolveAuthorizationInput): Promise<string> {
  const credential = input.credential;
  const resolvedScopes = resolveAuthorizationScopes(input.scope ?? input.defaultScope);
  const requestScope = resolveAuthorizationScopeArgument(input.scope ?? input.defaultScope);

  if (hasAuthorizationHeaderCredential(credential)) {
    return credential.getAuthorizationHeader(requestScope);
  }

  if (hasTokenCredential(credential)) {
    const accessToken = await credential.getToken(resolvedScopes);
    if (accessToken == null) {
      throw new Error("Unable to resolve a token from the configured credential");
    }

    return `${accessToken.tokenType ?? "Bearer"} ${accessToken.token}`;
  }

  const provider = getTokenProvider({
    fetch: input.fetch,
    authorityHost: input.authorityHost ?? input.defaultAuthorityHost,
    scopes: resolvedScopes,
    tokenProviders: input.tokenProviders,
  });

  const authorizationHeader = await provider.getAuthorizationHeader();
  return authorizationHeader;
}

function resolveAuthorizationScopeArgument(scope?: string | string[]): string | string[] {
  const values = resolveAuthorizationScopes(scope);
  if (values.length === 1) {
    return values[0]!;
  }

  return values;
}

interface TokenProviderInput {
  fetch: typeof globalThis.fetch;
  authorityHost?: string;
  scopes: string[];
  tokenProviders?: Map<string, TokenProvider>;
}

function getTokenProvider(input: TokenProviderInput): TokenProvider {
  const key = `${input.authorityHost ?? ""}|${JSON.stringify(input.scopes)}`;
  const providers = input.tokenProviders ?? new Map<string, TokenProvider>();

  const cached = providers.get(key);
  if (cached != null) {
    return cached;
  }

  const provider = createTokenProvider({
    cache: new Map<string, AccessToken | Promise<AccessToken>>(),
    loadToken: async () => {
      return loadDefaultToken({
        scope: input.scopes.length === 1 ? input.scopes[0]! : input.scopes,
        fetch: input.fetch,
        authorityHost: input.authorityHost,
      });
    },
    cacheKey: key,
  });

  providers.set(key, provider);
  return provider;
}
