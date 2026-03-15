import { toFormEntries, toFormUrlEncoded } from "./internal/form";
import { fetchJson } from "./internal/http";
import { sanitizeAuthorityHost, joinPath } from "./internal/url";
import { normalizeToken } from "./internal/oauth";
import { TokenRequestError, TokenUnavailableError } from "./errors";
import type { AccessToken } from "./types";

export interface ServicePrincipalOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope: string | string[];
  authorityHost?: string;
  fetch?: typeof globalThis.fetch;
}

export async function getServicePrincipalToken(options: ServicePrincipalOptions): Promise<AccessToken> {
  const { tenantId, clientId, clientSecret, scope } = options;

  if (tenantId.length === 0) {
    throw new TypeError("tenantId is required");
  }

  if (clientId.length === 0) {
    throw new TypeError("clientId is required");
  }

  if (clientSecret.length === 0) {
    throw new TypeError("clientSecret is required");
  }

  const scopes = Array.isArray(scope) ? scope : [scope];
  if (scopes.length === 0 || scopes.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError("At least one non-empty scope is required");
  }

  const fetcher = options.fetch ?? (typeof fetch === "undefined" ? undefined : fetch);
  if (fetcher == null) {
    throw new TokenUnavailableError("Fetch is not available");
  }

  const host = sanitizeAuthorityHost(options.authorityHost ?? "https://login.microsoftonline.com");
  const tokenUrl = joinPath(host, `/${tenantId}/oauth2/v2.0/token`);

  const form = toFormUrlEncoded(
    toFormEntries({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: scopes.join(" "),
    }),
  );

  const payload = await fetchJson(
    tokenUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
    fetcher,
  ).catch((error: unknown) => {
    if (error instanceof TokenRequestError) {
      throw error;
    }

    throw new TokenRequestError("Failed to request service principal token");
  });

  return normalizeToken(payload);
}
