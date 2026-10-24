import { DefaultAzureCredential } from './default-azure-credential'
import { getAuthorizationHeader, storageOAuthScope } from './internal/request-core'
import type { AzureRequestCredential } from './internal/request-core'
import { defaultFetch } from './internal/runtime'
import { requireHttpsUrl } from './internal/url'

export interface AzureRequestOverrides {
  scope?: string | string[]
  credential?: AzureRequestCredential
  authorityHost?: string
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
    const request = new Request(input, requestInit)
    const credential =
      azure.credential ??
      this.options.credential ??
      this.getDefaultCredential(azure.authorityHost ?? this.options.authorityHost)
    const scope = azure.scope ?? this.options.scope ?? storageOAuthScope

    request.headers.set('Authorization', await getAuthorizationHeader(credential, scope))
    return await this.fetcher(request)
  }

  private getDefaultCredential(authorityHost: string | undefined): DefaultAzureCredential {
    let credential = this.defaultCredentials.get(authorityHost)
    if (credential === undefined) {
      credential = new DefaultAzureCredential({ authorityHost, fetch: this.fetcher })
      this.defaultCredentials.set(authorityHost, credential)
    }

    return credential
  }
}
