import { TokenRequestError } from '../token-request-error'
import type { AccessToken } from '../types'
import { jsonProperty } from './json'
import { sendWithRetry, validatedUrl } from './request-core'
import type { RetryOptions } from './request-core'

const digitsOnly = /^\d+$/u

/** Sends an OAuth token request with retries and maps error responses to `TokenRequestError`. */
export async function fetchJson(
  input: string | URL,
  init: RequestInit,
  fetcher: typeof globalThis.fetch,
  retryOptions?: RetryOptions,
): Promise<unknown> {
  const url = validatedUrl(input, init)
  const response = await sendWithRetry(async () => await fetcher(url, init), {
    ...retryOptions,
    signal: init.signal,
    body: init.body,
  })
  if (response.ok) {
    // Body failures such as cancellation or a reset connection must reach the caller.
    const body = await response.text()
    try {
      return JSON.parse(body)
    } catch {
      // The parser error can quote the body, which may contain a token.
      throw new TokenRequestError('Token response is not valid JSON')
    }
  }

  const payload = await readErrorBody(response)
  const error = jsonProperty(payload, 'error')
  const code = typeof error === 'string' ? error : jsonProperty(error, 'code')
  const description = jsonProperty(payload, 'error_description')
  const status = `${response.status} ${response.statusText}`

  throw new TokenRequestError(
    typeof description === 'string' ? `${status}: ${description}` : status,
    response.status,
    typeof code === 'string' ? code : undefined,
  )
}

/** Normalizes an OAuth or managed identity token response. */
export function normalizeToken(payload: unknown, now = Date.now()): AccessToken {
  const accessToken = jsonProperty(payload, 'access_token')
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new TypeError('Missing access_token')
  }

  const expiresIn = parseSeconds(jsonProperty(payload, 'expires_in'))
  const expiresOnTimestamp =
    parseTimestamp(jsonProperty(payload, 'expires_on')) ??
    (expiresIn === undefined ? undefined : now + expiresIn * 1000)
  if (expiresOnTimestamp === undefined) {
    throw new TypeError('Unable to parse token expiration')
  }

  const refreshIn = parseSeconds(jsonProperty(payload, 'refresh_in'))
  return {
    token: accessToken,
    tokenType: 'Bearer',
    expiresOnTimestamp,
    refreshAfterTimestamp: refreshIn === undefined ? undefined : now + refreshIn * 1000,
  }
}

/** Normalizes the JSON printed by Azure CLI and Azure PowerShell. */
export function normalizeCommandToken(output: string): AccessToken {
  let payload: unknown
  try {
    payload = JSON.parse(output)
  } catch {
    // The parser error can quote the output, which may contain a token.
    throw new TokenRequestError('Failed to parse command output as JSON')
  }

  const accessToken = jsonProperty(payload, 'accessToken')
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new TokenRequestError('Missing accessToken in command response')
  }

  const expiresOnTimestamp = parseTimestamp(
    jsonProperty(payload, 'expires_on') ?? jsonProperty(payload, 'expiresOn'),
  )
  if (expiresOnTimestamp === undefined) {
    throw new TokenRequestError('Unable to parse command token expiration')
  }

  return { token: accessToken, tokenType: 'Bearer', expiresOnTimestamp }
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function parseSeconds(value: unknown): number | undefined {
  const seconds = typeof value === 'string' && digitsOnly.test(value) ? Number(value) : value
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : undefined
}

/** Accepts epoch seconds or milliseconds, as numbers or digit strings, and date strings. */
function parseTimestamp(value: unknown): number | undefined {
  const epoch = parseSeconds(value)
  if (epoch !== undefined) {
    return epoch > 1_000_000_000_000 ? epoch : epoch * 1000
  }

  const date = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isNaN(date) ? undefined : date
}
