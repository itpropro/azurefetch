const textEncoder = new TextEncoder()

export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(value)
}

export function decodeBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (character) => character.codePointAt(0) ?? 0)
}

export function encodeBytesToBase64(bytes: ArrayBuffer | ArrayBufferView): string {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return btoa(Array.from(view, (byte) => String.fromCodePoint(byte)).join(''))
}

/** Signs text with HMAC-SHA256 and a base64 key, as Azure Storage and App Configuration expect. */
export function createHmacSigner(base64Key: string): (text: string) => Promise<string> {
  const keyBytes = decodeBase64ToBytes(base64Key)
  let key: Promise<CryptoKey> | undefined

  return async (text) => {
    key ??= crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ])
    return encodeBytesToBase64(await crypto.subtle.sign('HMAC', await key, encodeUtf8(text)))
  }
}
