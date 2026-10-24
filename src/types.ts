export interface AccessToken {
  token: string
  tokenType?: 'Bearer' | 'pop'
  expiresOnTimestamp: number
  refreshAfterTimestamp?: number
}
