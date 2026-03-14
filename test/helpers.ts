import { vi } from "vitest";

export type FetchMock = typeof globalThis.fetch;

export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

export function createFetchMock(handlers: FetchHandler[]): FetchMock {
  let call = 0;

  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const handler = handlers[call];
    call += 1;

    if (handler == null) {
      throw new Error(`Unexpected fetch call ${call}`);
    }

    const normalizedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    const normalizedInit: RequestInit =
      input instanceof Request
        ? {
            ...(await normalizeRequestInit(input)),
            ...init,
          }
        : init;

    return Promise.resolve(handler(normalizedUrl, normalizedInit));
  }) as FetchMock;
}

async function normalizeRequestInit(request: Request): Promise<RequestInit> {
  let body = request.body;
  if (body != null && !request.bodyUsed) {
    const cloned = request.clone();
    body = await cloned.text();
  }

  return {
    method: request.method,
    headers: request.headers,
    body,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  };
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
