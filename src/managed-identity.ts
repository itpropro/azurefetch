import { getEnvironment } from "./internal/env";
import {
  getApiVersion,
  selectorQueryParams,
  resolveManagedIdentityConfig,
  resolveManagedIdentitySource,
} from "./internal/msi";
import { fetchJson } from "./internal/http";
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
  if (options.scope.length === 0) {
    throw new TypeError("Scope is required");
  }

  if (!options.scope.endsWith("/.default")) {
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

  if (config.method === "POST") {
    const body = toFormUrlEncoded(
      toFormEntries({
        resource,
        "api-version": getApiVersion(config.source),
      }),
    );

    const payload = await fetchJson(
      config.endpoint,
      {
        method: config.method,
        headers: config.headers,
        body,
      },
      fetcher,
    ).catch((error: unknown) => {
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

  if (source === "Imds") {
    return requestImdsToken(url, config.headers, fetcher, options.probeTimeoutMs);
  }

  const payload = await fetchJson(
    url.toString(),
    {
      method: config.method,
      headers: config.headers,
    },
    fetcher,
  );

  return normalizeToken(payload);
}

async function requestImdsToken(
  url: URL,
  headers: Record<string, string>,
  fetcher: typeof globalThis.fetch,
  probeTimeoutMs = 1000,
): Promise<AccessToken> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, probeTimeoutMs);

  try {
    const payload = await fetchJson(
      url.toString(),
      {
        method: "GET",
        headers,
        signal: controller.signal,
      },
      fetcher,
    );

    return normalizeToken(payload);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new TokenUnavailableError("IMDS token endpoint probe timed out", error);
    }

    if (error instanceof TokenRequestError && error.status != null && error.status < 500) {
      throw error;
    }

    throw new TokenUnavailableError("IMDS endpoint unavailable", error);
  } finally {
    clearTimeout(timeout);
  }
}
