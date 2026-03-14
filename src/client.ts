import { resolveAuthorizationHeader, type AzureRequestCredential } from "./internal/request-core";
import type { TokenProvider } from "./types";

type AzureClientCredential = AzureRequestCredential;

export interface AzureRequestOverrides {
  scope?: string | string[];
  credential?: AzureClientCredential;
  authorityHost?: string;
}

export interface AzureClientOptions extends AzureRequestOverrides {
  fetch?: typeof globalThis.fetch;
}

export interface AzureRequestInit extends RequestInit {
  azure?: AzureRequestOverrides;
}

export class AzureClient {
  private readonly fetcher: typeof globalThis.fetch;

  private readonly defaultCredential?: AzureClientCredential;

  private readonly defaultScope?: string | string[];

  private readonly defaultAuthorityHost?: string;

  private readonly defaultTokenProviders = new Map<string, TokenProvider>();

  constructor(options: AzureClientOptions = {}) {
    this.fetcher = options.fetch || globalThis.fetch;
    this.defaultCredential = options.credential;
    this.defaultScope = options.scope;
    this.defaultAuthorityHost = options.authorityHost;
  }

  public async fetch(input: RequestInfo | URL, init: AzureRequestInit = {}): Promise<Response> {
    const request = await this.sign(input, init);
    return this.fetcher(request);
  }

  public async sign(input: RequestInfo | URL, init: AzureRequestInit = {}): Promise<Request> {
    const request = new Request(input, this.extractRequestInit(init));
    const authorization = await this.getAuthorizationHeader(init.azure);
    request.headers.set("Authorization", authorization);
    return request;
  }

  private async getAuthorizationHeader(overrides: AzureRequestOverrides | undefined): Promise<string> {
    const credential = overrides?.credential ?? this.defaultCredential;
    const scope = overrides?.scope ?? this.defaultScope;
    const authorityHost = overrides?.authorityHost;

    return resolveAuthorizationHeader({
      credential,
      scope,
      authorityHost,
      fetch: this.fetcher,
      defaultScope: this.defaultScope,
      defaultAuthorityHost: this.defaultAuthorityHost,
      tokenProviders: this.defaultTokenProviders,
    });
  }

  private extractRequestInit(init: AzureRequestInit = {}): RequestInit {
    const { azure: _azure, ...requestInit } = init;
    return requestInit;
  }
}
