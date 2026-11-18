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

const contentIdPattern = /^content-id:[\t ]*(\d+)[\t ]*$/imu
const statusLinePattern = /^HTTP\/1\.1 (\d{3})(?:[ \r\n]|$)/u
const errorCodePattern = /^x-ms-error-code:\s*(\S+)/imu
const boundaryPattern = /boundary=([^;\s]+)/u
const headerSeparator = /\r?\n\r?\n/u
const lineSeparator = /\r?\n/u
const boundarySuffix = /^(--)?[\t ]*$/u

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
    if (blobUrls.length === 0 || blobUrls.length > 256) {
      throw new RangeError('Blob batch requires 1 to 256 blob URLs')
    }
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

    const subResponses = parseSubResponses(await response.text(), responseBoundary, urls.length)

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
function parseSubResponses(
  body: string,
  boundary: string,
  expected: number,
): BlobBatchSubResponse[] {
  const subResponses: BlobBatchSubResponse[] = []
  const delimiter = `--${boundary}`
  let partLines: string[] | undefined
  let closed = false
  for (const line of body.split(lineSeparator)) {
    const boundaryLine = line.startsWith(delimiter)
      ? boundarySuffix.exec(line.slice(delimiter.length))
      : null
    if (boundaryLine === null) {
      partLines?.push(line)
      continue
    }
    if (partLines !== undefined) {
      addSubResponse(partLines.join('\n'))
    }
    if (boundaryLine[1] !== undefined) {
      closed = true
      break
    }
    partLines = []
  }

  if (!closed || Object.keys(subResponses).length !== expected) {
    throw new Error('Blob batch response does not match its sub-requests')
  }
  return subResponses

  function addSubResponse(part: string): void {
    const [mimeHeaders = '', response = ''] = part.split(headerSeparator, 2)
    const contentId = contentIdPattern.exec(mimeHeaders)?.[1]
    const status = statusLinePattern.exec(response)?.[1]
    if (contentId !== undefined && status !== undefined) {
      const index = Number(contentId)
      if (index >= expected || subResponses[index] !== undefined) {
        throw new Error('Blob batch response does not match its sub-requests')
      }
      subResponses[index] = {
        status: Number(status),
        errorCode: errorCodePattern.exec(response)?.[1],
      }
    }
  }
}
