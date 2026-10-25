// Index scans instead of end-anchored regexes such as /x+$/, which backtrack quadratically on a
// long run of the character that doesn't end the string.

export function stripTrailing(value: string, character: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === character) {
    end -= 1
  }
  return value.slice(0, end)
}

export function stripSurrounding(value: string, character: string): string {
  let start = 0
  while (start < value.length && value[start] === character) {
    start += 1
  }
  return stripTrailing(value.slice(start), character)
}

/** Splits `Key=value;Key=value` connection strings; a value keeps any further `=`. */
export function parseConnectionString(connectionString: string): Map<string, string> {
  return new Map(
    connectionString
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part): [string, string] => {
        const separator = part.indexOf('=')
        return separator === -1 ? [part, ''] : [part.slice(0, separator), part.slice(separator + 1)]
      }),
  )
}
