const ipAddress = /^(?:\d{1,3}\.){3}\d{1,3}$/u
const trailingSlash = /\/$/u

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

/** Appends an already encoded path segment and keeps the query, such as a SAS token. */
export function appendUrlPath(baseUrl: string, path: string): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(trailingSlash, '')}/${path}`
  return url.toString()
}
