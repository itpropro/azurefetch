import { AzureFetchError } from './errors'

/** An Azure service answered a request with an error status. */
export class AzureRequestError extends AzureFetchError {
  public override name = 'AzureRequestError'
  public readonly status: number
  public readonly errorCode: string | undefined

  public constructor(message: string, status: number, errorCode?: string, cause?: unknown) {
    super(message, cause)
    this.status = status
    this.errorCode = errorCode
  }
}
