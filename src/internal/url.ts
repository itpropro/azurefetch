const trailingSlashes = /\/+$/u

export function sanitizeAuthorityHost(authorityHost: string): string {
  const trimmed = authorityHost.trim()
  requireHttpsUrl(trimmed, 'authorityHost')

  return trimmed.replace(trailingSlashes, '')
}

export function requireHttpsUrl(input: string, name: string): URL {
  const url = new URL(input)
  if (url.protocol !== 'https:') {
    throw new TypeError(`${name} must use HTTPS`)
  }

  return url
}
