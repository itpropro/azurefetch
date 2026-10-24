import type { TokenCredential } from '../types'
import { formatAuthorizationHeader } from './token'

export const storageOAuthScope = 'https://storage.azure.com/.default'
export const keyVaultOAuthScope = 'https://vault.azure.net/.default'
export const appConfigurationOAuthScope = 'https://appconfig.azure.com/.default'

interface HeaderCredential {
  getAuthorizationHeader: (scope?: string | string[]) => Promise<string>
}

export type AzureRequestCredential = HeaderCredential | TokenCredential

/** Signs the complete request, as App Configuration access keys require. */
export interface RequestSigningCredential {
  signRequest: (request: Request) => Promise<void>
}

export function resolveRequiredScopes(scope: string | string[]): string[] {
  const scopes = (Array.isArray(scope) ? scope : [scope])
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  if (scopes.length === 0) {
    throw new TypeError('At least one non-empty scope is required')
  }

  return scopes
}

export async function getAuthorizationHeader(
  credential: AzureRequestCredential,
  scope: string | string[],
): Promise<string> {
  if ('getAuthorizationHeader' in credential) {
    return await credential.getAuthorizationHeader(scope)
  }

  const token = await credential.getToken(resolveRequiredScopes(scope))
  if (token === null) {
    throw new Error('Unable to resolve a token from the configured credential')
  }

  return formatAuthorizationHeader(token)
}

export const defaultRetryableStatuses = [408, 429, 500, 502, 503, 504]
export const defaultMaxRetryDelayInMs = 60_000

const decimalNumber = /^-?\d+(?:\.\d+)?$/u

export interface RetryContext {
  /** Zero-based number of the attempt that failed. */
  attempt: number
  response?: Response
  error?: unknown
  /** Wait the service asked for in `retry-after-ms`, `x-ms-retry-after-ms` or `Retry-After`. */
  retryAfterInMs?: number
}

export interface RetryOptions {
  /** Retries after the first attempt; `0` disables retries. Defaults to 3. */
  maxRetries?: number
  /** Base of the exponential wait. Defaults to 1000. */
  retryDelayInMs?: number
  /** Longest wait; a longer service wait hint stops retrying. Defaults to 60000. */
  maxRetryDelayInMs?: number
  /** Defaults to 408, 429, 500, 502, 503 and 504. Network errors are always retryable. */
  retryableStatuses?: number[]
  /** Decides whether to retry; `undefined` keeps the default decision. */
  shouldRetry?: (context: RetryContext) => boolean | undefined
  /** Wait before the next attempt in milliseconds; `undefined` keeps the default wait. */
  retryDelay?: (context: RetryContext) => number | undefined
}

export interface RetrySettings extends RetryOptions {
  signal?: AbortSignal | null
  /** A stream body is consumed by the first attempt, so it is never retried. */
  body?: BodyInit | null
}

/** A stream body is consumed by the first attempt; other bodies can be sent again. */
export function isReplayableBody(body: BodyInit | null | undefined): boolean {
  return !(body instanceof ReadableStream)
}

/** Sends one HTTP request, retrying network errors and transient statuses after a wait. */
export async function sendWithRetry(
  send: () => Promise<Response>,
  { signal, body, ...options }: RetrySettings = {},
): Promise<Response> {
  const maxRetries = isReplayableBody(body) ? (options.maxRetries ?? 3) : 0
  const retryDelayInMs = options.retryDelayInMs ?? 1000
  const maxRetryDelayInMs = options.maxRetryDelayInMs ?? defaultMaxRetryDelayInMs
  const retryableStatuses = options.retryableStatuses ?? defaultRetryableStatuses

  const sendAttempt = async (attempt: number): Promise<Response> => {
    signal?.throwIfAborted()
    let context: RetryContext
    let retryable: boolean
    try {
      const response = await send()
      context = { attempt, response, retryAfterInMs: parseRetryAfter(response.headers) }
      retryable = retryableStatuses.includes(response.status)
    } catch (error) {
      signal?.throwIfAborted()
      context = { attempt, error }
      retryable = true
    }

    const withinHint = (context.retryAfterInMs ?? 0) <= maxRetryDelayInMs
    if (attempt >= maxRetries || !(options.shouldRetry?.(context) ?? (retryable && withinHint))) {
      if (context.response !== undefined) {
        return context.response
      }

      throw context.error
    }

    const delayInMs =
      options.retryDelay?.(context) ??
      context.retryAfterInMs ??
      exponentialDelay(attempt, retryDelayInMs, maxRetryDelayInMs)
    await context.response?.body?.cancel()
    await wait(Math.max(0, delayInMs), signal)
    return await sendAttempt(attempt + 1)
  }

  return await sendAttempt(0)
}

/** Exponential wait with jitter that keeps it between 80% and 100% of the exponential value. */
export function exponentialDelay(
  attempt: number,
  retryDelayInMs: number,
  maxRetryDelayInMs: number,
): number {
  return Math.min(maxRetryDelayInMs, retryDelayInMs * 2 ** attempt) * (0.8 + Math.random() * 0.2)
}

/** The first valid wait hint; a past `Retry-After` date means no wait. */
function parseRetryAfter(headers: Headers): number | undefined {
  for (const name of ['retry-after-ms', 'x-ms-retry-after-ms']) {
    const milliseconds = parseNonNegative(headers.get(name))
    if (milliseconds !== undefined) {
      return milliseconds
    }
  }

  const retryAfter = headers.get('retry-after')?.trim()
  if (retryAfter === undefined || decimalNumber.test(retryAfter)) {
    const seconds = parseNonNegative(retryAfter)
    return seconds === undefined ? undefined : seconds * 1000
  }

  const date = Date.parse(retryAfter)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function parseNonNegative(value: string | null | undefined): number | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || !decimalNumber.test(trimmed)) {
    return undefined
  }

  const number = Number(trimmed)
  return number >= 0 ? number : undefined
}

async function wait(delayInMs: number, signal: AbortSignal | null | undefined): Promise<void> {
  const cleanup = new AbortController()
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayInMs)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { signal: cleanup.signal },
      )
    })
  } finally {
    cleanup.abort()
  }

  signal?.throwIfAborted()
}
