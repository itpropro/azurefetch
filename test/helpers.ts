import { vi } from "vitest";

export type FetchMock = typeof globalThis.fetch;

export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

export function createFetchMock(handlers: FetchHandler[]): FetchMock {
  let call = 0;

  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const handler = handlers[call];
    call += 1;

    if (handler == null) {
      throw new Error(`Unexpected fetch call ${call}`);
    }

    return Promise.resolve(handler(String(url), init));
  }) as FetchMock;
}

export function textResponse(body: string, status = 200, statusText = "OK", headers: HeadersInit = {}): Response {
  const responseBody = status === 204 || status === 205 || status === 304 ? null : body;
  return new Response(responseBody, {
    status,
    statusText,
    headers,
  });
}

export function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: {
      "content-type": "application/json",
    },
  });
}

export function getBodyString(body: RequestInit["body"]): string {
  if (typeof body === "string") {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  return "";
}

export type EnvSnapshot = NodeJS.ProcessEnv;

export function captureEnv(): EnvSnapshot {
  return { ...process.env };
}

export function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

export function unavailableCommandError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}
