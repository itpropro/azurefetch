import type * as ChildProcess from 'node:child_process'
import type * as Crypto from 'node:crypto'
import type * as FsPromises from 'node:fs/promises'

interface RuntimeGlobals {
  process?: {
    env?: Partial<Record<string, string>>
    platform?: string
    versions?: { node?: string }
  }
}

const runtime: RuntimeGlobals = globalThis

// Built at runtime so edge bundlers don't try to resolve the Node builtin.
const childProcessModule = ['node', ['child', 'process'].join('_')].join(':')
const cryptoModule = ['node', 'crypto'].join(':')
const fsPromisesModule = ['node', ['fs', 'promises'].join('/')].join(':')

/** Uses the global `fetch` at call time, bound to the global object as browsers and workers require. */
export const defaultFetch: typeof globalThis.fetch = async (input, init) =>
  await globalThis.fetch(input, init)

/** Reads a non-empty environment variable; runtimes without `process` have none. */
export function getEnv(name: string): string | undefined {
  const value = runtime.process?.env?.[name]?.trim()
  return value === '' ? undefined : value
}

/** Reads a non-empty environment variable unchanged, as passwords may start or end with whitespace. */
export function getRawEnv(name: string): string | undefined {
  const value = runtime.process?.env?.[name]
  return value === '' ? undefined : value
}

export function hasCommandExecution(): boolean {
  return runtime.process?.versions?.node !== undefined
}

export function isWindows(): boolean {
  return runtime.process?.platform === 'win32'
}

export function isCommandUnavailable(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function executeCommand(
  command: string,
  args: string[],
  options: { signal?: AbortSignal; shell?: boolean } = {},
): Promise<string> {
  options.signal?.throwIfAborted()
  const childProcess: unknown = await import(childProcessModule)
  if (!isChildProcessModule(childProcess)) {
    throw new Error('Command execution is unavailable')
  }

  const result = await new Promise<{ error: Error | null; stdout: string }>((resolve) => {
    const child = childProcess.execFile(
      command,
      args,
      { signal: options.signal, shell: options.shell, windowsHide: true },
      (error, stdout) => {
        resolve({ error, stdout })
      },
    )
    // Commands must not wait for input that never comes.
    child.stdin?.end()
  })

  options.signal?.throwIfAborted()
  if (result.error !== null) {
    throw result.error
  }

  return result.stdout
}

export async function readTextFile(path: string): Promise<string> {
  const fs: unknown = await import(fsPromisesModule)
  if (!isFsPromisesModule(fs)) {
    throw new Error('File system access is unavailable')
  }

  return await fs.readFile(path, 'utf8')
}

/** Decrypts a password-protected PEM private key to PKCS#8 DER; Web Crypto can't. */
export async function decryptPrivateKey(
  pem: string,
  password: string,
): Promise<Uint8Array<ArrayBuffer>> {
  // Runtimes that can execute commands are the ones that provide node:crypto.
  const nodeCrypto: unknown = hasCommandExecution() ? await import(cryptoModule) : undefined
  if (!isCryptoModule(nodeCrypto)) {
    throw new Error('Encrypted private keys need a Node-compatible runtime')
  }

  try {
    const key = nodeCrypto.createPrivateKey({ key: pem, format: 'pem', passphrase: password })
    return new Uint8Array(key.export({ format: 'der', type: 'pkcs8' }))
  } catch (error) {
    // Each runtime's crypto library reports a wrong password differently.
    throw new Error('Unable to decrypt the private key with the given password', { cause: error })
  }
}

function isCryptoModule(value: unknown): value is typeof Crypto {
  return typeof value === 'object' && value !== null && 'createPrivateKey' in value
}

function isFsPromisesModule(value: unknown): value is typeof FsPromises {
  return typeof value === 'object' && value !== null && 'readFile' in value
}

function isChildProcessModule(value: unknown): value is typeof ChildProcess {
  return typeof value === 'object' && value !== null && 'execFile' in value
}
