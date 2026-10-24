import { createHmacSigner, encodeBytesToBase64, encodeUtf8 } from './storage-encoding'

/** Access key authentication of App Configuration: an HMAC over method, path, date, host and body hash. */
export class AppConfigurationKeyCredential {
  private readonly id: string
  private readonly sign: (text: string) => Promise<string>

  public constructor(id: string, secret: string) {
    this.id = id
    this.sign = createHmacSigner(secret)
  }

  public async signRequest(request: Request): Promise<void> {
    const url = new URL(request.url)
    const date = new Date().toUTCString()
    const body = encodeUtf8(await request.clone().text())
    const contentHash = encodeBytesToBase64(await crypto.subtle.digest('SHA-256', body))
    const signature = await this.sign(
      `${request.method}\n${url.pathname}${url.search}\n${date};${url.host};${contentHash}`,
    )

    request.headers.set('x-ms-date', date)
    request.headers.set('x-ms-content-sha256', contentHash)
    request.headers.set(
      'Authorization',
      `HMAC-SHA256 Credential=${this.id}&SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
    )
  }
}
