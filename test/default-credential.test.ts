import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/internal/process", () => ({
  hasCommandExecution: vi.fn(),
  isCommandUnavailable: vi.fn(),
  executeCommand: vi.fn(),
}));

import { getDefaultAzureCredentialToken } from "../src/default-credential";
import { TokenRequestError, TokenUnavailableError } from "../src/errors";
import { executeCommand, hasCommandExecution, isCommandUnavailable } from "../src/internal/process";

type FetchMock = typeof globalThis.fetch;

const mockExecuteCommand = vi.mocked(executeCommand);
const mockHasCommandExecution = vi.mocked(hasCommandExecution);
const mockIsCommandUnavailable = vi.mocked(isCommandUnavailable);

function createFetchMock(
  handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>,
): FetchMock {
  let index = 0;

  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const handler = handlers[index];

    if (handler == null) {
      throw new Error("Unexpected fetch call");
    }

    index += 1;
    return handler(String(url), init);
  }) as FetchMock;
}

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: {
      "content-type": "application/json",
    },
  });
}

function unavailableCommandError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

describe("getDefaultAzureCredentialToken", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };

    vi.clearAllMocks();
    mockHasCommandExecution.mockReturnValue(true);
    mockIsCommandUnavailable.mockImplementation((error) => (error as NodeJS.ErrnoException)?.code === "ENOENT");
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("uses managed identity first", async () => {
    process.env.IDENTITY_ENDPOINT = "https://appservice.azurewebsites.net/identity";
    process.env.IDENTITY_HEADER = "my-id-token";

    const fetchMock = createFetchMock([
      (url, init) => {
        expect(new URL(url).searchParams.get("resource")).toBe("scope-resource");
        expect(init.headers).toMatchObject({
          Metadata: "true",
          "X-IDENTITY-HEADER": "my-id-token",
        });

        return jsonResponse({
          access_token: "mi-token",
          expires_in: 3600,
        });
      },
    ]);

    const token = await getDefaultAzureCredentialToken({
      scope: "scope-resource/.default",
      fetch: fetchMock,
    });

    expect(token.token).toBe("mi-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  test("falls back to service principal when managed identity is unavailable", async () => {
    process.env.AZURE_TENANT_ID = "tenant";
    process.env.AZURE_CLIENT_ID = "client";
    process.env.AZURE_CLIENT_SECRET = "secret";

    const fetchMock = createFetchMock([
      () =>
        new Response("", {
          status: 500,
          statusText: "IMDS unavailable",
        }),
      (url) => {
        expect(url).toBe("https://identity.test/tenant/oauth2/v2.0/token");
        return jsonResponse({
          access_token: "sp-token",
          expires_in: 3600,
        });
      },
    ]);

    const token = await getDefaultAzureCredentialToken({
      scope: "scope/.default",
      authorityHost: "https://identity.test",
      fetch: fetchMock,
    });

    expect(token.token).toBe("sp-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  test("falls back to Azure CLI when service principal is unavailable", async () => {
    const fetchMock = createFetchMock([
      () =>
        new Response("", {
          status: 500,
          statusText: "IMDS unavailable",
        }),
    ]);

    mockExecuteCommand.mockImplementation(async (command, args) => {
      expect(command).toBe("az");
      expect(args).toEqual(["account", "get-access-token", "--output", "json", "--scope", "scope/.default"]);

      return {
        stdout: JSON.stringify({
          accessToken: "cli-token",
          expires_on: 1_700_000_000_001,
        }),
        stderr: "",
      };
    });

    const token = await getDefaultAzureCredentialToken({
      scope: "scope/.default",
      fetch: fetchMock,
    });

    expect(token.token).toBe("cli-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
  });

  test("falls back to Azure PowerShell when CLI is unavailable", async () => {
    const fetchMock = createFetchMock([
      () =>
        new Response("", {
          status: 500,
          statusText: "IMDS unavailable",
        }),
    ]);

    mockExecuteCommand.mockImplementation(async (command) => {
      if (command === "az") {
        throw unavailableCommandError("az missing");
      }

      return {
        stdout: JSON.stringify({
          accessToken: "powershell-token",
          tokenType: "Bearer",
          expiresOn: "1700000000100",
        }),
        stderr: "",
      };
    });

    const token = await getDefaultAzureCredentialToken({
      scope: "resource/.default",
      fetch: fetchMock,
    });

    expect(token.token).toBe("powershell-token");
    expect(mockExecuteCommand).toHaveBeenCalledWith("az", [
      "account",
      "get-access-token",
      "--output",
      "json",
      "--scope",
      "resource/.default",
    ]);
    expect(mockExecuteCommand).toHaveBeenCalledWith("pwsh", [
      "-NoProfile",
      "-NoLogo",
      "-NonInteractive",
      "-Command",
      expect.stringContaining("Get-AzAccessToken -ResourceUrl 'resource'"),
    ]);
  });

  test("does not continue to CLI when service principal request fails", async () => {
    process.env.AZURE_TENANT_ID = "tenant";
    process.env.AZURE_CLIENT_ID = "client";
    process.env.AZURE_CLIENT_SECRET = "secret";

    const fetchMock = createFetchMock([
      () =>
        new Response("", {
          status: 500,
          statusText: "IMDS unavailable",
        }),
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_client",
            },
            error_description: "invalid credentials",
          }),
          {
            status: 401,
            statusText: "Unauthorized",
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    ]);

    await expect(
      getDefaultAzureCredentialToken({
        scope: "scope/.default",
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(TokenRequestError);

    expect(mockExecuteCommand).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("throws when no credentials are available", async () => {
    const fetchMock = createFetchMock([
      () =>
        new Response("", {
          status: 500,
          statusText: "IMDS unavailable",
        }),
    ]);

    mockExecuteCommand.mockImplementation(async (command) => {
      throw unavailableCommandError(`${command} missing`);
    });

    await expect(
      getDefaultAzureCredentialToken({
        scope: "scope/.default",
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(TokenUnavailableError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(3);
  });
});
