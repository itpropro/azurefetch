import { getEnvironment } from "./internal/env";
import {
  getApiVersion,
  selectorQueryParams,
  resolveManagedIdentityConfig,
  resolveManagedIdentitySource,
} from "./internal/msi";
import { appendQuery, fetchJson } from "./internal/http";
import { normalizeToken } from "./internal/oauth";
import { TokenUnavailableError, TokenRequestError } from "./errors";
import { toFormEntries, toFormUrlEncoded } from "./internal/form";
import type { AccessToken } from "./types";

interface ManagedIdentityOptions {
  scope: string;
  clientId?: string;
  objectId?: string;
  resourceId?: string;
  fetch?: typeof globalThis.fetch;
  probeTimeoutMs?: number;
}

export async function getManagedIdentityToken(options: ManagedIdentityOptions): Promise<AccessToken> {
  if (options.scope == null || options.scope.length === 0) {
    throw new TypeError("Scope is required");
  }

  if (options.scope == null || !options.scope.endsWith("/.default")) {
    throw new TypeError("Scope must end with /.default");
  }

  if (/\s/.test(options.scope)) {
    throw new TypeError("Managed identity requires exactly one scope");
  }

  if (options.clientId != null && options.objectId != null) {
    throw new TypeError("Specify at most one of clientId, objectId, or resourceId");
  }

  if (options.clientId != null && options.resourceId != null) {
    throw new TypeError("Specify at most one of clientId, objectId, or resourceId");
  }

  if (options.objectId != null && options.resourceId != null) {
    throw new TypeError("Specify at most one of clientId, objectId, or resourceId");
  }

  const resource = options.scope.slice(0, -"/.default".length);
  const env = getEnvironment();
  const source = resolveManagedIdentitySource(env);
  const fetcher = options.fetch ?? (typeof fetch === "undefined" ? undefined : fetch);

  if (fetcher == null) {
    throw new TokenUnavailableError("Fetch is not available");
  }

  if (source === "CloudShell" && (options.clientId != null || options.objectId != null || options.resourceId != null)) {
    throw new TokenUnavailableError("CloudShell managed identity does not support explicit identity selectors");
  }

  const config = resolveManagedIdentityConfig(env, source, resource, {
    clientId: options.clientId,
    objectId: options.objectId,
    resourceId: options.resourceId,
  });

  if (source === "Imds") {
    await ensureImdsAvailable(config.endpoint, fetcher, options.probeTimeoutMs);
  }

  if (config.method === "POST") {
    const body = toFormUrlEncoded(
      toFormEntries({
        resource,
        "api-version": getApiVersion(config.source),
      }),
    );

    const payload = await fetchJson<unknown>(
      config.endpoint,
      {
        method: config.method,
        headers: config.headers,
        body,
      },
      fetcher,
    ).catch((error) => {
      if (error instanceof TokenRequestError) {
        throw error;
      }

      throw new TokenRequestError("Failed to request managed identity token");
    });

    return normalizeToken(payload);
  }

  const params = selectorQueryParams(
    resource,
    {
      clientId: options.clientId,
      objectId: options.objectId,
      resourceId: options.resourceId,
    },
    config.source,
  );

  const url = new URL(config.endpoint);
  for (const [key, value] of params.entries()) {
    url.searchParams.set(key, value);
  }

  const payload = await fetchJson<unknown>(
    url.toString(),
    {
      method: config.method,
      headers: config.headers,
    },
    fetcher,
  );

  return normalizeToken(payload);
}

async function ensureImdsAvailable(
  endpoint: string,
  fetcher: typeof globalThis.fetch,
  probeTimeoutMs = 1000,
): Promise<void> {
  const url = new URL(endpoint);
  appendQuery(url, "api-version", "2018-02-01");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), probeTimeoutMs);

  try {
    const response = await fetcher(url.toString(), {
      method: "GET",
      headers: {
        Metadata: "true",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`IMDS probe returned ${response.status} ${response.statusText}`);
    }

    return;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new TokenUnavailableError("IMDS token endpoint probe timed out", error);
    }

    throw new TokenUnavailableError("IMDS endpoint unavailable", error);
  } finally {
    clearTimeout(timeout);
  }
}
