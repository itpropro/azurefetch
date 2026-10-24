import { fetchJson, normalizeToken } from './internal/oauth'
import { defaultFetch, getEnv } from './internal/runtime'
import { TokenRequestError } from './token-request-error'
import { TokenUnavailableError } from './token-unavailable-error'
import type { AccessToken } from './types'

export interface ManagedIdentityOptions {
  scope: string
  clientId?: string
  objectId?: string
  resourceId?: string
  fetch?: typeof globalThis.fetch
}

const imdsProbeTimeoutMs = 1000
const whitespace = /\s/u

export async function getManagedIdentityToken(
  options: ManagedIdentityOptions,
): Promise<AccessToken> {
  const { scope, clientId, objectId, resourceId } = options
  if (!scope.endsWith('/.default')) {
    throw new TypeError('Scope must end with /.default')
  }

  if (whitespace.test(scope)) {
    throw new TypeError('Managed identity requires exactly one scope')
  }

  const selectorCount = [clientId, objectId, resourceId].filter(
    (value) => value !== undefined,
  ).length
  if (selectorCount > 1) {
    throw new TypeError('Specify at most one of clientId, objectId, or resourceId')
  }

  const resource = scope.slice(0, -'/.default'.length)
  const fetcher = options.fetch ?? defaultFetch
  const identityEndpoint = getEnv('IDENTITY_ENDPOINT')
  const identityHeader = getEnv('IDENTITY_HEADER')
  const msiEndpoint = getEnv('MSI_ENDPOINT')

  if (identityEndpoint !== undefined && identityHeader !== undefined) {
    const url = tokenUrl(identityEndpoint, '2019-08-01', resource, options, 'mi_res_id')
    return await requestToken(
      url,
      { headers: { Metadata: 'true', 'X-IDENTITY-HEADER': identityHeader } },
      fetcher,
    )
  }

  if (msiEndpoint !== undefined) {
    if (selectorCount > 0) {
      throw new TokenUnavailableError(
        'Cloud Shell managed identity does not support explicit identity selectors',
      )
    }

    return await requestToken(
      new URL(msiEndpoint),
      {
        method: 'POST',
        headers: { Metadata: 'true' },
        body: new URLSearchParams({ resource, 'api-version': '2017-09-01' }),
      },
      fetcher,
    )
  }

  const imdsHost = getEnv('AZURE_POD_IDENTITY_AUTHORITY_HOST') ?? 'http://169.254.169.254'
  const imdsEndpoint = `${imdsHost}/metadata/identity/oauth2/token`
  await probeImds(imdsEndpoint, fetcher)
  const url = tokenUrl(imdsEndpoint, '2018-02-01', resource, options, 'msi_res_id')
  return await requestToken(url, { headers: { Metadata: 'true' } }, fetcher)
}

function tokenUrl(
  endpoint: string,
  apiVersion: string,
  resource: string,
  selector: ManagedIdentityOptions,
  resourceIdParameter: string,
): URL {
  const url = new URL(endpoint)
  url.searchParams.set('api-version', apiVersion)
  url.searchParams.set('resource', resource)
  for (const [name, value] of [
    ['client_id', selector.clientId],
    ['object_id', selector.objectId],
    [resourceIdParameter, selector.resourceId],
  ] as const) {
    if (value !== undefined) {
      url.searchParams.set(name, value)
    }
  }

  return url
}

/** IMDS answers a request without the metadata header immediately, so any response proves it is reachable. */
async function probeImds(endpoint: string, fetcher: typeof globalThis.fetch): Promise<void> {
  try {
    const response = await fetcher(endpoint, { signal: AbortSignal.timeout(imdsProbeTimeoutMs) })
    await response.body?.cancel()
  } catch (error) {
    throw new TokenUnavailableError('IMDS endpoint unavailable', error)
  }
}

async function requestToken(
  url: URL,
  init: RequestInit,
  fetcher: typeof globalThis.fetch,
): Promise<AccessToken> {
  let payload: unknown
  try {
    payload = await fetchJson(url, init, fetcher)
  } catch (error) {
    if (error instanceof TokenRequestError && error.status !== undefined && error.status < 500) {
      throw error
    }

    throw new TokenUnavailableError('Managed identity endpoint unavailable', error)
  }

  return normalizeToken(payload)
}
