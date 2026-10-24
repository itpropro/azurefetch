/** Reads a property of parsed JSON without trusting its shape. */
export function jsonProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}
