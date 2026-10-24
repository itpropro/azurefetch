import type { BlobDeleteOptions } from './block-blob-client'
import {
  StorageTransport,
  multipartBoundary,
  storageRequestError,
} from './internal/storage-request'
import type { StorageClientOptions, StorageCredential } from './internal/storage-request'

export interface BlobBatchSubResponse {
  status: number
  errorCode?: string
}

export interface BlobBatchSubmitResponse {
  subResponses: BlobBatchSubResponse[]
  subResponsesSucceededCount: number
  subResponsesFailedCount: number
}

const contentIdPattern = /^content-id:\s*(\d+)/imu
const statusLinePattern = /^HTTP\/1\.1 (\d{3})/mu
const errorCodePattern = /^x-ms-error-code:\s*(\S+)/imu
const boundaryPattern = /boundary=([^;\s]+)/u

export class BlobBatchClient {
  private readonly url: string
  private readonly transport: StorageTransport

  public constructor(url: string, credential?: StorageCredential, options?: StorageClientOptions) {
    this.url = url
    this.transport = new StorageTransport(credential, options)
  }

  /** Deletes up to 256 blobs of the account in one batch request. */
  public async deleteBlobs(
    blobUrls: string[],
    options: BlobDeleteOptions = {},
  ): Promise<BlobBatchSubmitResponse> {
    const account = new URL(this.url)
    const accountPath = account.pathname.endsWith('/') ? account.pathname : `${account.pathname}/`
    const urls = blobUrls.map((blobUrl) => new URL(blobUrl))
    // Sub-requests carry only the path, so a blob of another account would hit this one.
    const foreign = urls.find(
      (url) => url.origin !== account.origin || !url.pathname.startsWith(accountPath),
    )
    if (foreign !== undefined) {
      throw new TypeError(`Blob ${foreign.toString()} does not belong to ${this.url}`)
    }

    const boundary = multipartBoundary('batch')
    const parts = await Promise.all(
      urls.map(async (url, index) => {
        const headers = new Headers({ 'x-ms-date': new Date().toUTCString() })
        if (options.deleteSnapshots !== undefined) {
          headers.set('x-ms-delete-snapshots', options.deleteSnapshots)
        }
        await this.transport.authorize('DELETE', url, headers)

        return [
          `--${boundary}`,
          'Content-Type: application/http',
          'Content-Transfer-Encoding: binary',
          `Content-ID: ${index}`,
          '',
          `DELETE ${url.pathname}${url.search} HTTP/1.1`,
          ...Array.from(headers, ([name, value]) => `${name}: ${value}`),
          '',
          '',
        ].join('\r\n')
      }),
    )

    const response = await this.transport.send('POST', this.url, {
      query: { comp: 'batch' },
      headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
      body: `${parts.join('\r\n')}\r\n--${boundary}--\r\n`,
    })
    if (response.status !== 202) {
      throw storageRequestError('Blob batch', response)
    }

    const responseBoundary = boundaryPattern.exec(response.headers.get('content-type') ?? '')?.[1]
    if (responseBoundary === undefined) {
      throw new Error('Blob batch response is missing its multipart boundary')
    }

    const subResponses = parseSubResponses(await response.text(), responseBoundary)
    if (Object.keys(subResponses).length !== blobUrls.length) {
      throw new Error('Blob batch response does not match its sub-requests')
    }

    const succeeded = subResponses.filter(
      ({ status, errorCode }) => status >= 200 && status < 300 && errorCode === undefined,
    ).length
    return {
      subResponses,
      subResponsesSucceededCount: succeeded,
      subResponsesFailedCount: subResponses.length - succeeded,
    }
  }
}

/** Orders sub-responses by the Content-ID of the sub-request they answer. */
function parseSubResponses(body: string, boundary: string): BlobBatchSubResponse[] {
  const subResponses: BlobBatchSubResponse[] = []
  for (const part of body.split(`--${boundary}`)) {
    const contentId = contentIdPattern.exec(part)?.[1]
    const status = statusLinePattern.exec(part)?.[1]
    if (contentId !== undefined && status !== undefined) {
      subResponses[Number(contentId)] = {
        status: Number(status),
        errorCode: errorCodePattern.exec(part)?.[1],
      }
    }
  }

  return subResponses
}
