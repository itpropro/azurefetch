import { AzureFetchError } from './errors'

/** A credential source is not available here; credential chains continue with the next source. */
export class TokenUnavailableError extends AzureFetchError {
  public override name = 'TokenUnavailableError'
}
