const ipAddress = /^(?:\d{1,3}\.){3}\d{1,3}$/u
const trailingSlash = /\/$/u
const dotPathSegment = /[/\\](?:\.|%2e){1,2}(?=[/\\]|$)/iu
const urlPathEnd = /[?#]/u

/** Account name from host-style (`account.blob.…`) or path-style emulator URLs. */
export function getAccountNameFromUrl(url: string): string {
  const parsedUrl = new URL(url)
  const [account = '', service] = parsedUrl.hostname.split('.')

  if (service === 'blob' || service === 'table') {
    return account
  }

  const host = parsedUrl.hostname
  if (host === 'localhost' || host === 'host.docker.internal' || ipAddress.test(host)) {
    return parsedUrl.pathname.split('/').find((segment) => segment.length > 0) ?? ''
  }

  return ''
}

/** Drops a trailing slash from the path and keeps the query, such as a SAS token. */
export function normalizeStorageUrl(rawUrl: string): string {
  const url = new URL(rawUrl)
  if (url.pathname !== '/') {
    url.pathname = url.pathname.replace(trailingSlash, '')
  }

  return url.toString()
}

/** Checks the supplied path before the URL parser can remove a segment. */
export function rejectStorageUrlDotSegments(rawUrl: string): void {
  // The URL parser trims ASCII space and C0 controls from the ends.
  let start = 0
  let end = rawUrl.length
  while (start < end && (rawUrl.codePointAt(start) ?? Infinity) <= 0x20) {
    start++
  }
  while (end > start && (rawUrl.codePointAt(end - 1) ?? Infinity) <= 0x20) {
    end--
  }
  const [urlPath = ''] = rawUrl
    .slice(start, end)
    .replaceAll(/[\t\r\n]/gu, '')
    .split(urlPathEnd, 1)
  if (dotPathSegment.test(urlPath)) {
    throw new TypeError('Storage resource URL cannot contain dot segments')
  }
}

/** Appends an already encoded path segment and keeps the query, such as a SAS token. */
export function appendUrlPath(baseUrl: string, path: string): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(trailingSlash, '')}/${path}`
  return url.toString()
}

/** Appends text to the last path segment, as OData entity and query paths need, and keeps the query. */
export function extendUrlPath(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl)
  url.pathname += suffix
  return url.toString()
}
