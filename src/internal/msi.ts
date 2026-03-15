import { getEnv } from "./env";
import type { Environment } from "./env";

export type ManagedIdentitySource = "AppService" | "CloudShell" | "Imds" | "Unknown";

export interface ManagedIdentityConfig {
  source: ManagedIdentitySource;
  endpoint: string;
  selectorParams: Record<string, string>;
  headers: Record<string, string>;
  method: "GET" | "POST";
  body?: string;
}

export function resolveManagedIdentitySource(env: Environment): ManagedIdentitySource {
  const identityEndpoint = getEnv(env, "IDENTITY_ENDPOINT");
  const identityHeader = getEnv(env, "IDENTITY_HEADER");
  const msiEndpoint = getEnv(env, "MSI_ENDPOINT");

  if (identityEndpoint != null && identityHeader != null) {
    return "AppService";
  }

  if (msiEndpoint != null) {
    return "CloudShell";
  }

  return "Imds";
}

export function resolveManagedIdentityConfig(
  env: Environment,
  source: ManagedIdentitySource,
  resource: string,
  selector: {
    clientId?: string;
    objectId?: string;
    resourceId?: string;
  },
): ManagedIdentityConfig {
  switch (source) {
    case "AppService": {
      const endpoint = getEnv(env, "IDENTITY_ENDPOINT");

      if (endpoint == null) {
        throw new TypeError("IDENTITY_ENDPOINT is required for AppService managed identity");
      }

      const headers: Record<string, string> = {
        Metadata: "true",
      };

      const identityHeader = getEnv(env, "IDENTITY_HEADER");
      if (identityHeader != null) {
        headers["X-IDENTITY-HEADER"] = identityHeader;
      }

      const selectorParams = pickSelectorParams(selector);

      return {
        source,
        endpoint,
        selectorParams,
        headers,
        method: "GET",
      };
    }

    case "CloudShell": {
      const endpoint = getEnv(env, "MSI_ENDPOINT");

      if (endpoint == null) {
        throw new TypeError("MSI_ENDPOINT is required for CloudShell managed identity");
      }

      return {
        source,
        endpoint,
        selectorParams: {},
        headers: {
          Metadata: "true",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      };
    }

    case "Imds":
    case "Unknown": {
      const authorityHost = getEnv(env, "AZURE_POD_IDENTITY_AUTHORITY_HOST") ?? "http://169.254.169.254";

      return {
        source,
        endpoint: `${authorityHost}/metadata/identity/oauth2/token`,
        selectorParams: pickSelectorParams(selector),
        headers: {
          Metadata: "true",
        },
        method: "GET",
      };
    }

    default: {
      throw new TypeError("Unsupported managed identity source");
    }
  }
}

export function selectorQueryParams(
  resource: string,
  selector: { clientId?: string; objectId?: string; resourceId?: string },
  source: ManagedIdentitySource = "Imds",
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("resource", resource);
  params.set("api-version", getApiVersion(source));
  const selectorParams = pickSelectorParams(selector);
  for (const [key, value] of Object.entries(selectorParams)) {
    params.set(key, value);
  }

  return params;
}

function pickSelectorParams(selector: {
  clientId?: string;
  objectId?: string;
  resourceId?: string;
}): Record<string, string> {
  if (selector.clientId != null) {
    return {
      client_id: selector.clientId,
    };
  }

  if (selector.objectId != null) {
    return {
      object_id: selector.objectId,
    };
  }

  if (selector.resourceId != null) {
    return {
      msi_res_id: selector.resourceId,
    };
  }

  return {};
}

export function getApiVersion(source: ManagedIdentitySource = "Imds"): string {
  if (source === "AppService") {
    return "2019-08-01";
  }

  if (source === "CloudShell") {
    return "2017-09-01";
  }

  return "2018-02-01";
}
