import { stripTrailing } from './text'

export function sanitizeAuthorityHost(authorityHost: string): string {
  const trimmed = authorityHost.trim()
  requireHttpsUrl(trimmed, 'authorityHost')

  return stripTrailing(trimmed, '/')
}

export function requireHttpsUrl(input: string, name: string): URL {
  const url = new URL(input)
  if (url.protocol !== 'https:') {
    throw new TypeError(`${name} must use HTTPS`)
  }

  return url
}

/** HTTPS service endpoint without trailing slashes, query or fragment. */
export function normalizeServiceUrl(input: string, name: string): string {
  const url = requireHttpsUrl(input, name)
  return `${url.origin}${stripTrailing(url.pathname, '/')}`
}
