import { createHmacSigner } from './internal/storage-encoding'

export class StorageSharedKeyCredential {
  public readonly accountName: string
  private readonly sign: (text: string) => Promise<string>

  public constructor(accountName: string, accountKey: string) {
    if (accountName.length === 0) {
      throw new TypeError('accountName is required')
    }

    if (accountKey.length === 0) {
      throw new TypeError('accountKey is required')
    }

    this.accountName = accountName
    this.sign = createHmacSigner(accountKey)
  }

  public async computeHMACSHA256(stringToSign: string): Promise<string> {
    return await this.sign(stringToSign)
  }
}
