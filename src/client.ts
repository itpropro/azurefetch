import { DefaultAzureCredential } from './default-azure-credential'
import {
  getAuthorizationHeader,
  isReplayableBody,
  sendWithRetry,
  storageOAuthScope,
} from './internal/request-core'
import type {
  AzureRequestCredential,
  RequestSigningCredential,
  RetryOptions,
} from './internal/request-core'
import { defaultFetch } from './internal/runtime'
import { requireHttpsUrl } from './internal/url'

export type AzureClientCredential = AzureRequestCredential | RequestSigningCredential

export interface AzureRequestOverrides {
  scope?: string | string[]
  credential?: AzureClientCredential
  authorityHost?: string
  /** Retries of the request; token requests use the options of their credential. */
  retryOptions?: RetryOptions
}

export interface AzureClientOptions extends AzureRequestOverrides {
  fetch?: typeof globalThis.fetch
}

export interface AzureRequestInit extends RequestInit {
  azure?: AzureRequestOverrides
}

export class AzureClient {
  private readonly options: AzureClientOptions
  private readonly fetcher: typeof globalThis.fetch
  private readonly defaultCredentials = new Map<string | undefined, DefaultAzureCredential>()

  public constructor(options: AzureClientOptions = {}) {
    if (options.authorityHost !== undefined) {
      requireHttpsUrl(options.authorityHost, 'authorityHost')
    }
    this.options = options
    this.fetcher = options.fetch ?? defaultFetch
  }

  public async fetch(input: RequestInfo | URL, init: AzureRequestInit = {}): Promise<Response> {
    const { azure = {}, ...requestInit } = init
    // `Request` turns every body into a stream, so replayability is decided on the original body.
    const body = requestInit.body ?? (input instanceof Request ? input.body : null)
    const replayable = isReplayableBody(body)
    const request = new Request(input, requestInit)
    const credential =
      azure.credential ??
      this.options.credential ??
      this.getDefaultCredential(azure.authorityHost ?? this.options.authorityHost)
    const scope = azure.scope ?? this.options.scope ?? storageOAuthScope

    if ('signRequest' in credential) {
      await credential.signRequest(request)
    } else {
      request.headers.set('Authorization', await getAuthorizationHeader(credential, scope))
    }

    return await sendWithRetry(
      async () => await this.fetcher(replayable ? request.clone() : request),
      { ...this.options.retryOptions, ...azure.retryOptions, signal: request.signal, body },
    )
  }

  private getDefaultCredential(authorityHost: string | undefined): DefaultAzureCredential {
    let credential = this.defaultCredentials.get(authorityHost)
    if (credential === undefined) {
      credential = new DefaultAzureCredential({
        authorityHost,
        retryOptions: this.options.retryOptions,
        fetch: this.fetcher,
      })
      this.defaultCredentials.set(authorityHost, credential)
    }

    return credential
  }
}
