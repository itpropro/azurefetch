import { AzureRequestError } from '../azure-request-error'

/** Builds an AzureRequestError from a JSON error body; `fields` picks the service's code and message. */
export async function jsonRequestError(
  operation: string,
  response: Response,
  fields: (body: unknown) => { code: unknown; message: unknown },
): Promise<AzureRequestError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }

  const { code, message } = fields(body)
  const errorCode = typeof code === 'string' ? code : undefined
  const detail = typeof message === 'string' ? message : response.statusText
  return new AzureRequestError(
    `${operation} failed: ${response.status} ${detail}${errorCode === undefined ? '' : ` (${errorCode})`}`,
    response.status,
    errorCode,
  )
}
