import { TokenUnavailableError, TokenRequestError } from "./errors";
import { getEnvironment, getEnv } from "./internal/env";
import { resolveRequiredScopes } from "./internal/request-core";
import { executeCommand, hasCommandExecution, isCommandUnavailable } from "./internal/process";
import type { CommandExecutionOptions, CommandExecutionResult } from "./internal/process";
import { parseNumericTimestamp } from "./internal/oauth";
import { sanitizeAuthorityHost } from "./internal/url";
import { getManagedIdentityToken } from "./managed-identity";
import { getServicePrincipalToken } from "./service-principal";
import type { AccessToken } from "./types";

interface DefaultAzureCredentialOptions {
  scope: string | string[];
  authorityHost?: string;
  managedIdentityClientId?: string;
  fetch?: typeof globalThis.fetch;
  probeTimeoutMs?: number;
}

export interface DeveloperAzureCredentialOptions {
  scope: string | string[];
  abortSignal?: AbortSignal;
}

interface ExternalCommandCredentialOptions {
  commandRunner: (
    command: string,
    args: string[],
    options?: CommandExecutionOptions,
  ) => Promise<CommandExecutionResult>;
  abortSignal?: AbortSignal;
}

interface ExternalCommandTokenPayload {
  accessToken?: unknown;
  tokenType?: unknown;
  expires_on?: unknown;
  expiresOn?: unknown;
}

export async function getDefaultAzureCredentialToken(options: DefaultAzureCredentialOptions): Promise<AccessToken> {
  const authorityHost = options.authorityHost == null ? undefined : sanitizeAuthorityHost(options.authorityHost);
  const scopes = resolveRequiredScopes(options.scope);
  const environment = getEnvironment();

  const singleScope = scopes.length === 1 ? scopes[0] : undefined;
  const singleDefaultScope = singleScope?.endsWith("/.default") === true ? singleScope : undefined;

  const tenantId = getEnv(environment, "AZURE_TENANT_ID");
  const clientId = getEnv(environment, "AZURE_CLIENT_ID");
  const clientSecret = getEnv(environment, "AZURE_CLIENT_SECRET");

  if (tenantId != null && clientId != null && clientSecret != null) {
    const servicePrincipalToken = await tryAcquireToken(tenantId, async () =>
      getServicePrincipalToken({
        tenantId,
        clientId,
        clientSecret,
        scope: scopes,
        authorityHost,
        fetch: options.fetch,
      }),
    );

    if (servicePrincipalToken != null) {
      return servicePrincipalToken;
    }
  }

  const managedIdentityToken = await tryAcquireToken(singleDefaultScope, async () =>
    getManagedIdentityToken({
      scope: singleDefaultScope!,
      clientId: options.managedIdentityClientId,
      fetch: options.fetch,
      probeTimeoutMs: options.probeTimeoutMs,
    }),
  );

  if (managedIdentityToken != null) {
    return managedIdentityToken;
  }

  const cliToken = await tryAcquireToken("azure cli", async () =>
    getAzureCliToken(scopes, {
      commandRunner: executeCommand,
    }),
  );

  if (cliToken != null) {
    return cliToken;
  }

  const powershellToken = await tryAcquireToken("azure powershell", async () =>
    getAzurePowerShellToken(scopes, {
      commandRunner: executeCommand,
    }),
  );

  if (powershellToken != null) {
    return powershellToken;
  }

  const failures = [
    tenantId == null || clientId == null || clientSecret == null ? "missing environment credentials" : undefined,
    "managed identity unavailable",
    "azure cli unavailable",
    "azure powershell unavailable",
  ].filter((value): value is string => value != null);

  throw new TokenUnavailableError(`Could not find available credentials: ${failures.join(", ")}`);
}

export async function getDeveloperAzureCredentialToken(options: DeveloperAzureCredentialOptions): Promise<AccessToken> {
  options.abortSignal?.throwIfAborted();
  const scopes = resolveRequiredScopes(options.scope);
  const commandOptions = {
    commandRunner: executeCommand,
    abortSignal: options.abortSignal,
  };

  const cliToken = await tryAcquireToken("azure cli", async () => getAzureCliToken(scopes, commandOptions));
  if (cliToken != null) {
    return cliToken;
  }

  const powershellToken = await tryAcquireToken("azure powershell", async () =>
    getAzurePowerShellToken(scopes, commandOptions),
  );
  if (powershellToken != null) {
    return powershellToken;
  }

  throw new TokenUnavailableError(
    "Could not find available developer credentials: azure cli unavailable, azure powershell unavailable",
  );
}

function tryGetResourceFromScope(scope: string): string {
  if (!scope.endsWith("/.default")) {
    return scope;
  }

  return scope.slice(0, -"/.default".length);
}

async function tryAcquireToken<T>(shouldTry: unknown, acquire: () => Promise<T>): Promise<T | undefined> {
  if (shouldTry == null) {
    return undefined;
  }

  try {
    return await acquire();
  } catch (error: unknown) {
    if (error instanceof TokenUnavailableError) {
      return undefined;
    }

    throw error;
  }
}

async function getAzureCliToken(scopes: string[], options: ExternalCommandCredentialOptions): Promise<AccessToken> {
  options.abortSignal?.throwIfAborted();
  if (!hasCommandExecution()) {
    throw new TokenUnavailableError("Command execution is unavailable");
  }

  const command = "az";
  const args = ["account", "get-access-token", "--output", "json", "--scope", scopes.join(" ")];

  let result: { stdout: string; stderr: string };
  try {
    result = await runCredentialCommand(command, args, options);
  } catch (error: unknown) {
    options.abortSignal?.throwIfAborted();

    if (isCommandUnavailable(error) || error instanceof TokenUnavailableError) {
      throw new TokenUnavailableError("Azure CLI is unavailable", error);
    }

    throw new TokenUnavailableError("Azure CLI token request failed", error);
  }

  return normalizeCommandToken(parseJsonOutput(result.stdout));
}

async function getAzurePowerShellToken(
  scopes: string[],
  options: ExternalCommandCredentialOptions,
): Promise<AccessToken> {
  options.abortSignal?.throwIfAborted();
  const singleScope = scopes.length === 1 ? scopes[0] : undefined;
  if (singleScope == null) {
    throw new TokenUnavailableError("PowerShell credential requires exactly one scope");
  }

  if (!hasCommandExecution()) {
    throw new TokenUnavailableError("Command execution is unavailable");
  }

  const resource = tryGetResourceFromScope(singleScope);
  const escapedResource = resource.replace(/'/g, "''");

  const script = [
    "$env:AZUREPS_OUTPUT_PLAINTEXT_AZACCESSTOKEN='true'",
    `$token = Get-AzAccessToken -ResourceUrl '${escapedResource}'`,
    "$props = @{",
    "  accessToken = $token.Token",
    "  tokenType = if ($token.TokenType) { $token.TokenType } else { 'Bearer' }",
    "  expiresOn = $token.ExpiresOn",
    "}",
    "$props | ConvertTo-Json -Compress",
  ].join(";");

  const candidates = ["pwsh", "powershell"];
  let lastError: unknown;

  for (const command of candidates) {
    try {
      const result = await runCredentialCommand(
        command,
        ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", script],
        options,
      );

      return normalizeCommandToken(parseJsonOutput(result.stdout));
    } catch (error: unknown) {
      options.abortSignal?.throwIfAborted();
      lastError = error;

      if (!isCommandUnavailable(error)) {
        throw new TokenUnavailableError("Azure PowerShell token request failed", error);
      }
    }
  }

  throw new TokenUnavailableError("Azure PowerShell is unavailable", lastError);
}

async function runCredentialCommand(
  command: string,
  args: string[],
  options: ExternalCommandCredentialOptions,
): Promise<CommandExecutionResult> {
  if (options.abortSignal == null) {
    return options.commandRunner(command, args);
  }

  return options.commandRunner(command, args, { abortSignal: options.abortSignal });
}

function parseJsonOutput(raw: string): unknown {
  const normalizedRaw = raw.trim();
  try {
    return JSON.parse(normalizedRaw);
  } catch {
    throw new TokenRequestError("Failed to parse command output as JSON");
  }
}

function normalizeCommandToken(payload: unknown): AccessToken {
  if (payload == null || typeof payload !== "object") {
    throw new TokenRequestError("Invalid token response format");
  }

  const response = payload as ExternalCommandTokenPayload;
  const tokenValue = response.accessToken;

  if (typeof tokenValue !== "string" || tokenValue.length === 0) {
    throw new TokenRequestError("Missing accessToken in command response");
  }

  const expiresValue = response.expires_on ?? response.expiresOn;
  const expiresOnTimestamp = parseNumericTimestamp(expiresValue);

  if (expiresOnTimestamp == null) {
    throw new TokenRequestError("Unable to parse command token expiration");
  }

  return {
    token: tokenValue,
    tokenType: "Bearer",
    expiresOnTimestamp,
  };
}
