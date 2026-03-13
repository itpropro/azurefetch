export interface AccessToken {
  token: string;
  tokenType: "Bearer";
  expiresOnTimestamp: number;
  refreshAfterTimestamp?: number;
}

export interface TokenReuseOptions {
  now?: number;
  refreshSkewMs?: number;
}

export interface TokenProvider {
  getToken(): Promise<AccessToken>;
  getAuthorizationHeader(): Promise<string>;
}
