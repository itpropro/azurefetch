const textEncoder = new TextEncoder();

interface RuntimeBuffer {
  from(value: string, encoding: "base64"): Uint8Array;
  from(value: ArrayBufferView | ArrayBuffer): { toString(encoding: "base64"): string };
}

function getRuntimeBuffer(): RuntimeBuffer | undefined {
  return (globalThis as typeof globalThis & { Buffer?: RuntimeBuffer }).Buffer;
}

function toUint8Array(bytes: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }

  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  return new Uint8Array(bytes);
}

export function encodeUtf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  const runtimeBuffer = getRuntimeBuffer();
  if (runtimeBuffer != null) {
    return Uint8Array.from(runtimeBuffer.from(base64, "base64"));
  }

  throw new Error("A runtime base64 decoder is required to decode shared key values");
}

export function encodeBytesToBase64(bytes: ArrayBuffer | ArrayBufferView): string {
  const normalizedBytes = toUint8Array(bytes);

  if (typeof globalThis.btoa === "function") {
    let binary = "";
    for (const byte of normalizedBytes) {
      binary += String.fromCharCode(byte);
    }

    return globalThis.btoa(binary);
  }

  const runtimeBuffer = getRuntimeBuffer();
  if (runtimeBuffer != null) {
    return runtimeBuffer.from(normalizedBytes).toString("base64");
  }

  throw new Error("A runtime base64 encoder is required to encode shared key signatures");
}
