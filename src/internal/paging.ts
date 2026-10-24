export interface PageSettings {
  continuationToken?: string
}

export interface ListOptions extends PageSettings {
  maxPageSize?: number
}

/** Iterates items directly or page by page with `byPage`. */
export interface PagedAsyncIterableIterator<T, TPage> extends AsyncIterable<T> {
  byPage: (settings?: PageSettings) => AsyncIterable<TPage>
}

export interface Page<T> {
  page: T
  continuationToken?: string
}

/** Requests one page per iteration step and stops when a page has no continuation token. */
export function paginate<T>(
  fetchPage: (continuationToken: string | undefined) => Promise<Page<T>>,
  continuationToken?: string,
): AsyncIterableIterator<T> {
  let next = continuationToken
  let done = false

  const iterator: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      if (done) {
        return { done: true, value: undefined }
      }

      const result = await fetchPage(next)
      next = result.continuationToken
      done = next === undefined
      return { done: false, value: result.page }
    },
  }

  return iterator
}

/** Adds item iteration on top of a page iterator. */
export function pagedItems<T, TPage extends { value: T[] }>(
  byPage: (settings?: PageSettings) => AsyncIterable<TPage>,
): PagedAsyncIterableIterator<T, TPage> {
  return {
    byPage,
    async *[Symbol.asyncIterator]() {
      for await (const page of byPage()) {
        yield* page.value
      }
    },
  }
}
