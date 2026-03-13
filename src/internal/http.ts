import { TokenRequestError } from "../errors";

export interface HttpRequestContext {
  url: string;
  init?: RequestInit;
}

type OAuthErrorPayload = {
  error?: string | { code?: string };
  error_description?: string;
};

export async function fetchJson<T>(input: string, init: RequestInit, fetcher: typeof globalThis.fetch): Promise<T> {
  const response = await fetcher(input, init);

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let errorCode: string | undefined;

    try {
      const payload = (await response.json()) as OAuthErrorPayload;

      if (typeof payload.error === "string") {
        errorCode = payload.error;
      } else if (payload.error?.code != null) {
        errorCode = payload.error.code;
      }

      if (typeof payload.error_description === "string") {
        message += `: ${payload.error_description}`;
      }
    } catch {
      // ignore
    }

    throw new TokenRequestError(message, response.status, errorCode);
  }

  return (await response.json()) as T;
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
