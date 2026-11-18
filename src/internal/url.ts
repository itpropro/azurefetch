import { stripTrailing } from './text'

export function sanitizeAuthorityHost(authorityHost: string): string {
  const trimmed = authorityHost.trim()
  const url = requireHttpsUrl(trimmed, 'authorityHost')
  if (url.href.includes('?') || url.href.includes('#')) {
    throw new TypeError('authorityHost cannot contain a query or fragment')
  }

  return stripTrailing(trimmed, '/')
}

export function encodeResourceSegment(value: string, name: string): string {
  if (value.trim().length === 0 || value === '.' || value === '..') {
    throw new TypeError(`${name} must be a non-empty string other than "." or ".."`)
  }
  return encodeURIComponent(value)
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
