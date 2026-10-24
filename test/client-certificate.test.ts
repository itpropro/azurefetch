import { X509Certificate, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { createClientAssertion, loadClientCertificate } from '../src/internal/client-certificate'

const password = ' fixture password '
const audience = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token'
const certificateBlocks = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu
const beforePrivateKey = /(?=-----BEGIN PRIVATE KEY-----)/u
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u
const fixtures = new URL('fixtures/certificates/', import.meta.url)
const pkcs8 = await readFixture('pkcs8.pem')
const pkcs1 = await readFixture('pkcs1.pem')
const encryptedPkcs8 = await readFixture('encrypted-pkcs8.pem')
const encryptedLegacy = await readFixture('encrypted-legacy.pem')
const chain = await readFixture('chain.pem')
const pfx = await readFixture('client.pfx')
const encryptedKeys = [
  ['encrypted PKCS#8', encryptedPkcs8],
  ['legacy encrypted PEM', encryptedLegacy],
]

async function readFixture(name: string): Promise<string> {
  return await readFile(new URL(name, fixtures), 'utf8')
}

async function sign(pem: string, sendCertificateChain?: boolean): Promise<string> {
  const certificate = await loadClientCertificate(pem)
  return await createClientAssertion(certificate, {
    clientId: 'client-id',
    audience,
    sendCertificateChain,
  })
}

function decodeAssertion(assertion: string): {
  header: Record<string, unknown>
  claims: Record<string, unknown>
} {
  const [header = '', claims = ''] = assertion.split('.')
  return { header: decodeJson(header), claims: decodeJson(claims) }
}

function decodeJson(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  return typeof value === 'object' && value !== null ? { ...value } : {}
}

/** Verifies the signature with the public key of the first certificate in the PEM file. */
async function verifyAssertion(assertion: string, pem: string): Promise<boolean> {
  const spki = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })
  const publicKey = await crypto.subtle.importKey(
    'spki',
    new Uint8Array(spki),
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const [header = '', claims = '', signature = ''] = assertion.split('.')
  return await crypto.subtle.verify(
    { name: 'RSA-PSS', saltLength: 32 },
    publicKey,
    new Uint8Array(Buffer.from(signature, 'base64url')),
    new TextEncoder().encode(`${header}.${claims}`),
  )
}

describe('client certificate assertions', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test.each([
    ['PKCS#8', pkcs8, undefined],
    ['PKCS#1', pkcs1, undefined],
    ['encrypted PKCS#8', encryptedPkcs8, password],
    ['legacy encrypted PEM', encryptedLegacy, password],
  ])('signs with %s keys', async (_format, pem, keyPassword) => {
    const certificate = await loadClientCertificate(pem, keyPassword)
    const assertion = await createClientAssertion(certificate, { clientId: 'client-id', audience })

    await expect(verifyAssertion(assertion, pem)).resolves.toBe(true)
  })

  test('signs without process or Buffer on the global object', async () => {
    const runtime: { process?: unknown; Buffer?: unknown } = globalThis
    const { process: originalProcess, Buffer: originalBuffer } = runtime
    runtime.process = undefined
    runtime.Buffer = undefined
    let assertions: string[]
    try {
      assertions = await Promise.all([sign(pkcs8), sign(pkcs1)])
    } finally {
      runtime.process = originalProcess
      runtime.Buffer = originalBuffer
    }

    const verified = assertions.map(async (assertion) => await verifyAssertion(assertion, pkcs8))
    await expect(Promise.all(verified)).resolves.toStrictEqual([true, true])
  })

  test('identifies the certificate by its SHA-256 thumbprint without the chain', async () => {
    const thumbprint = createHash('sha256')
      .update(new X509Certificate(chain).raw)
      .digest('base64url')

    const assertions = await Promise.all([sign(chain), sign(chain, false)])

    for (const assertion of assertions) {
      expect(decodeAssertion(assertion).header).toStrictEqual({
        alg: 'PS256',
        typ: 'JWT',
        'x5t#S256': thumbprint,
      })
    }
  })

  test('sends the certificate chain in PEM order when requested', async () => {
    const certificates = Array.from(chain.matchAll(certificateBlocks), ([block]) =>
      new X509Certificate(block).raw.toString('base64'),
    )

    expect(certificates).toHaveLength(2)
    expect(decodeAssertion(await sign(chain, true)).header).toMatchObject({ x5c: certificates })
  })

  test('claims the client ID for the token endpoint for 10 minutes', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-24T12:00:00.750Z'), toFake: ['Date'] })
    const now = Date.parse('2026-10-24T12:00:00Z') / 1000

    const { jti, ...claims } = decodeAssertion(await sign(pkcs8)).claims

    expect(claims).toStrictEqual({
      aud: audience,
      iss: 'client-id',
      sub: 'client-id',
      nbf: now,
      iat: now,
      exp: now + 600,
    })
    expect(jti).toMatch(uuid)
    expect(decodeAssertion(await sign(pkcs8)).claims['jti']).not.toBe(jti)
  })

  test.each(encryptedKeys)(
    'decrypts %s keys only with the exact password',
    async (_format, pem) => {
      await expect(loadClientCertificate(pem, password.trim())).rejects.toThrow(
        'Unable to decrypt the private key with the given password',
      )
    },
  )

  test.each(encryptedKeys)('rejects %s keys without a password', async (_format, pem) => {
    await expect(loadClientCertificate(pem)).rejects.toThrow(
      'The private key is encrypted and requires a password',
    )
  })

  test('rejects encrypted keys in runtimes without Node compatibility', async () => {
    vi.stubGlobal('process', undefined)

    await expect(loadClientCertificate(encryptedPkcs8, password)).rejects.toThrow(
      'Encrypted private keys need a Node-compatible runtime',
    )
  })

  test('rejects a PFX file like @azure/identity', async () => {
    await expect(loadClientCertificate(pfx, '')).rejects.toThrow(
      'The file at the specified path does not contain a PEM-encoded certificate.',
    )
  })

  test('rejects PEM contents without a certificate or an RSA private key', async () => {
    const [certificate = '', key = ''] = pkcs8.split(beforePrivateKey)

    await expect(loadClientCertificate(key)).rejects.toThrow(
      'The file at the specified path does not contain a PEM-encoded certificate.',
    )
    await expect(loadClientCertificate(certificate)).rejects.toThrow(
      'The file at the specified path does not contain a PEM-encoded private key.',
    )
    await expect(
      loadClientCertificate(
        `${certificate}-----BEGIN EC PRIVATE KEY-----\nAA==\n-----END EC PRIVATE KEY-----\n`,
      ),
    ).rejects.toThrow('Unsupported EC PRIVATE KEY; client certificates need an RSA private key')
  })
})
