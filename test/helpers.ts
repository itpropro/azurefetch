import { vi } from 'vitest'

export type FetchMock = typeof globalThis.fetch

export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>

/** Answers each fetch call with the next handler and fails on unexpected calls. */
export function createFetchMock(handlers: FetchHandler[]): FetchMock {
  let call = 0

  return vi.fn<FetchMock>(async (input, init = {}) => {
    const handler = handlers[call]
    call += 1

    if (handler === undefined) {
      throw new Error(`Unexpected fetch call ${call}`)
    }

    if (input instanceof Request) {
      const body = input.body === null ? undefined : await input.clone().text()
      return await handler(input.url, {
        method: input.method,
        headers: input.headers,
        body,
        signal: input.signal,
        ...init,
      })
    }

    return await handler(input.toString(), init)
  })
}

export function textResponse(
  body: string,
  status = 200,
  statusText = 'OK',
  headers: HeadersInit = {},
): Response {
  const responseBody = status === 204 || status === 205 || status === 304 ? null : body
  return new Response(responseBody, { status, statusText, headers })
}

export function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return Response.json(body, { status, statusText })
}

export function getBodyString(body: RequestInit['body']): string {
  if (typeof body === 'string') {
    return body
  }

  return body instanceof URLSearchParams ? body.toString() : ''
}

const credentialEnvironment = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'IDENTITY_ENDPOINT',
  'IDENTITY_HEADER',
  'MSI_ENDPOINT',
  'AZURE_POD_IDENTITY_AUTHORITY_HOST',
]

/** Hides credentials of the host so the credential chain only sees what a test sets. */
export function clearCredentialEnvironment(): void {
  for (const name of credentialEnvironment) {
    vi.stubEnv(name, undefined)
  }
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const item of items) {
    collected.push(item)
  }

  return collected
}

/** Unique suffix for resources that integration tests create in shared accounts. */
export function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
