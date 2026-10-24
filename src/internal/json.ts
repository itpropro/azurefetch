/** Reads a property of parsed JSON without trusting its shape. */
export function jsonProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

export function readString(value: unknown, key: string): string | undefined {
  const property = jsonProperty(value, key)
  return typeof property === 'string' ? property : undefined
}

export function readNumber(value: unknown, key: string): number | undefined {
  const property = jsonProperty(value, key)
  return typeof property === 'number' ? property : undefined
}

export function readBoolean(value: unknown, key: string): boolean | undefined {
  const property = jsonProperty(value, key)
  return typeof property === 'boolean' ? property : undefined
}

/** String-valued entries of a JSON object, such as resource tags. */
export function readStringRecord(value: unknown, key: string): Record<string, string> | undefined {
  const property = jsonProperty(value, key)
  if (typeof property !== 'object' || property === null) {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(property).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}
