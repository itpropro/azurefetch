import { TokenRequestError } from "../errors";

export interface HttpRequestContext {
  url: string;
  init?: RequestInit;
}

export async function fetchJson(input: string, init: RequestInit, fetcher: typeof globalThis.fetch): Promise<unknown> {
  const response = await fetcher(input, init);

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let errorCode: string | undefined;

    try {
      const payload = await parseResponseJson(response);

      const candidateCode = getOAuthErrorCode(payload);
      if (candidateCode != null) {
        errorCode = candidateCode;
      }

      const description = getOAuthErrorDescription(payload);
      if (description != null) {
        message += `: ${description}`;
      }
    } catch {
      // ignore
    }

    throw new TokenRequestError(message, response.status, errorCode);
  }

  const payload = await parseResponseJson(response);
  return payload;
}

async function parseResponseJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function getOAuthErrorCode(payload: unknown): string | undefined {
  if (!isOAuthErrorPayload(payload)) {
    return undefined;
  }

  const error = payload.error;
  if (typeof error === "string") {
    return error;
  }

  if (error != null && typeof error === "object" && typeof error.code === "string") {
    return error.code;
  }

  return undefined;
}

function getOAuthErrorDescription(payload: unknown): string | undefined {
  if (!isOAuthErrorPayload(payload)) {
    return undefined;
  }

  return typeof payload.error_description === "string" ? payload.error_description : undefined;
}

function isOAuthErrorPayload(
  payload: unknown,
): payload is { error?: string | { code?: string }; error_description?: string } {
  if (!isRecord(payload)) {
    return false;
  }

  const candidate = payload;
  const error = candidate.error;
  if (error == null) {
    return typeof candidate.error_description === "undefined" || typeof candidate.error_description === "string";
  }

  if (typeof error === "string") {
    return typeof candidate.error_description === "undefined" || typeof candidate.error_description === "string";
  }

  if (typeof error !== "object") {
    return false;
  }

  if (!isRecord(error)) {
    return false;
  }

  const code = error.code;
  if (code != null && typeof code !== "string") {
    return false;
  }

  return typeof candidate.error_description === "undefined" || typeof candidate.error_description === "string";
}

export function appendQuery(url: URL, key: string, value: string | undefined): URL {
  if (value == null) {
    return url;
  }

  url.searchParams.set(key, value);
  return url;
}

export async function fetchText(input: string, init: RequestInit, fetcher: typeof globalThis.fetch): Promise<string> {
  const response = await fetcher(input, init);

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    throw new TokenRequestError(message, response.status);
  }

  return response.text();
}
