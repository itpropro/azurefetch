export class AzureFetchError extends Error {
  public override name = 'AzureFetchError'

  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
  }
}
