import { paginate } from './paging'
import type { ListOptions } from './paging'
import { storageRequestError } from './storage-request'
import type { StorageTransport } from './storage-request'

export interface NamePage {
  names: string[]
  continuationToken: string
}

// The Blob service returns at most 5,000 items per list request.
const maxListPageSize = 5000
const itemPatterns = {
  Blob: /<Blob>([\s\S]*?)<\/Blob>/gu,
  Container: /<Container>([\s\S]*?)<\/Container>/gu,
}
const namePattern = /<Name(?<encoded> Encoded="true")?>(?<name>[^<]*)<\/Name>/u
const nextMarkerPattern = /<NextMarker>([^<]*)<\/NextMarker>/u
const xmlEntity = /&(?:#x([\da-f]+)|#(\d+)|([a-z]+));/giu
const namedEntities = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['amp', '&'],
])

/** Lists blob or container names page by page with the Blob service marker protocol. */
export function listNames(
  transport: StorageTransport,
  url: string,
  item: 'Blob' | 'Container',
  query: Partial<Record<string, string>>,
  options: ListOptions = {},
): AsyncIterableIterator<NamePage> {
  return paginate(async (marker) => {
    const maxresults =
      options.maxPageSize === undefined
        ? undefined
        : String(Math.min(options.maxPageSize, maxListPageSize))
    const response = await transport.send('GET', url, {
      query: { ...query, comp: 'list', maxresults, marker },
    })
    if (!response.ok) {
      throw storageRequestError(`${item} list`, response)
    }

    const xml = await response.text()
    const continuationToken = nextMarkerPattern.exec(xml)?.[1]?.trim() ?? ''
    const names = Array.from(
      xml.matchAll(itemPatterns[item]),
      ([, content = '']) => namePattern.exec(content)?.groups,
    )
      .filter((groups) => groups?.['name'] !== undefined)
      .map((groups) => decodeName(groups?.['name'] ?? '', groups?.['encoded'] !== undefined))

    return {
      page: { names, continuationToken },
      continuationToken: continuationToken === '' ? undefined : continuationToken,
    }
  }, options.continuationToken)
}

/** Names with characters that XML cannot carry are percent-encoded and flagged with Encoded="true". */
function decodeName(raw: string, encoded: boolean): string {
  const name = raw.replaceAll(
    xmlEntity,
    (entity, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (hex !== undefined || decimal !== undefined) {
        const codePoint = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16)
        if (codePoint > 0x10ffff) {
          throw new RangeError(
            'Blob Storage listing contains an out-of-range XML character reference',
          )
        }
        return String.fromCodePoint(codePoint)
      }

      return namedEntities.get(named ?? '') ?? entity
    },
  )

  return encoded ? decodeURIComponent(name) : name
}
