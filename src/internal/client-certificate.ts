import { decryptPrivateKey } from './runtime'
import { decodeBase64ToBytes, encodeBytesToBase64, encodeUtf8 } from './storage-encoding'

export interface ClientCertificate {
  /** Base64url SHA-256 digest of the first certificate's DER bytes. */
  thumbprint: string
  /** Base64 DER certificates in PEM order. */
  chain: string[]
  privateKey: CryptoKey
}

export interface ClientAssertionOptions {
  clientId: string
  /** The token endpoint. */
  audience: string
  /** Sends the chain as `x5c` for subject name and issuer authentication. */
  sendCertificateChain?: boolean
}

interface PemBlock {
  text: string
  label: string
  body: string
}

const pemBlocks = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/gu
const whitespace = /\s/gu
const base64Padding = /=+$/u
// PrivateKeyInfo version 0 and the rsaEncryption algorithm, which precede a PKCS#1 key in PKCS#8.
const rsaPrivateKeyInfoPrefix = [
  0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]
const assertionLifetimeSeconds = 600

/** Reads the certificates and the RSA private key from the contents of a PEM file. */
export async function loadClientCertificate(
  pem: string,
  password?: string,
): Promise<ClientCertificate> {
  const blocks = Array.from(pem.matchAll(pemBlocks), ([text, label = '', body = '']): PemBlock => ({
    text,
    label,
    body,
  }))
  const chain = blocks
    .filter(({ label }) => label === 'CERTIFICATE')
    .map(({ body }) => body.replaceAll(whitespace, ''))
  const [certificate] = chain
  if (certificate === undefined) {
    throw new Error('The file at the specified path does not contain a PEM-encoded certificate.')
  }

  const key = blocks.find(({ label }) => label.endsWith('PRIVATE KEY'))
  if (key === undefined) {
    throw new Error('The file at the specified path does not contain a PEM-encoded private key.')
  }

  const digest = await crypto.subtle.digest('SHA-256', decodeBase64ToBytes(certificate))
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    await readPkcs8(key, password),
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return { thumbprint: encodeBase64Url(digest), chain, privateKey }
}

/** Signs a PS256 client assertion that is valid for 10 minutes. */
export async function createClientAssertion(
  certificate: ClientCertificate,
  options: ClientAssertionOptions,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = {
    alg: 'PS256',
    typ: 'JWT',
    'x5t#S256': certificate.thumbprint,
    x5c: options.sendCertificateChain === true ? certificate.chain : undefined,
  }
  const claims = {
    aud: options.audience,
    iss: options.clientId,
    sub: options.clientId,
    jti: crypto.randomUUID(),
    nbf: now,
    iat: now,
    exp: now + assertionLifetimeSeconds,
  }
  const content = `${encodeJson(header)}.${encodeJson(claims)}`
  // PS256 uses a salt as long as the SHA-256 digest.
  const signature = await crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 },
    certificate.privateKey,
    encodeUtf8(content),
  )
  return `${content}.${encodeBase64Url(signature)}`
}

async function readPkcs8(
  { text, label, body }: PemBlock,
  password: string | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  // Legacy encrypted keys keep the RSA PRIVATE KEY label and announce the cipher in headers.
  if (label === 'ENCRYPTED PRIVATE KEY' || body.includes('Proc-Type:')) {
    if (password === undefined) {
      throw new Error('The private key is encrypted and requires a password')
    }

    return await decryptPrivateKey(text, password)
  }

  const der = decodeBase64ToBytes(body.replaceAll(whitespace, ''))
  if (label === 'PRIVATE KEY') {
    return der
  }

  if (label === 'RSA PRIVATE KEY') {
    return encodeDer(0x30, [...rsaPrivateKeyInfoPrefix, ...encodeDer(0x04, der)])
  }

  throw new Error(`Unsupported ${label}; client certificates need an RSA private key`)
}

/** Encodes a DER element; lengths from 128 take a `0x80 | n` byte and then n big-endian bytes. */
function encodeDer(tag: number, content: Uint8Array | number[]): Uint8Array<ArrayBuffer> {
  const length: number[] = []
  for (let rest = content.length; rest > 0; rest = Math.floor(rest / 256)) {
    length.unshift(rest % 256)
  }

  const lengthBytes = content.length < 0x80 ? [content.length] : [0x80 | length.length, ...length]
  return Uint8Array.from([tag, ...lengthBytes, ...content])
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(encodeUtf8(JSON.stringify(value)))
}

function encodeBase64Url(bytes: ArrayBuffer | ArrayBufferView): string {
  return encodeBytesToBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(base64Padding, '')
}
