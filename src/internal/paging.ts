export interface ListOptions {
  continuationToken?: string
  maxPageSize?: number
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
