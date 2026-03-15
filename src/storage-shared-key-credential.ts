import { decodeBase64ToBytes, encodeBytesToBase64, encodeUtf8 } from "./internal/storage-encoding";

export interface StorageSharedKeySigner {
  readonly accountName: string;
  computeHMACSHA256(stringToSign: string): Promise<string>;
}

export class StorageSharedKeyCredential implements StorageSharedKeySigner {
  public readonly accountKey: string;
  private readonly accountKeyBytes: Uint8Array;
  private importedKeyPromise?: Promise<CryptoKey>;

  constructor(
    public readonly accountName: string,
    accountKey: string,
  ) {
    if (accountName.length === 0) {
      throw new TypeError("accountName is required");
    }

    if (accountKey.length === 0) {
      throw new TypeError("accountKey is required");
    }

    this.accountKey = accountKey;
    this.accountKeyBytes = decodeBase64ToBytes(accountKey);
  }

  public async computeHMACSHA256(stringToSign: string): Promise<string> {
    const cryptoKey = await this.getImportedKey();
    const signature = await getSubtleCrypto().sign("HMAC", cryptoKey, encodeUtf8(stringToSign));
    return encodeBytesToBase64(signature);
  }

  private async getImportedKey(): Promise<CryptoKey> {
    this.importedKeyPromise ??= getSubtleCrypto().importKey(
      "raw",
      this.accountKeyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    return this.importedKeyPromise;
  }
}

function getSubtleCrypto(): SubtleCrypto {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto == null) {
    throw new Error("Web Crypto API is required for shared key signing");
  }

  return globalCrypto.subtle;
}
