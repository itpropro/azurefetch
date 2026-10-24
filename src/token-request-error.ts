import { AzureFetchError } from './errors'

/** A credential source is available but its token request failed; credential chains stop here. */
export class TokenRequestError extends AzureFetchError {
  public override name = 'TokenRequestError'
  public readonly status: number | undefined
  public readonly errorCode: string | undefined

  public constructor(message: string, status?: number, errorCode?: string, cause?: unknown) {
    super(message, cause)
    this.status = status
    this.errorCode = errorCode
  }
}
