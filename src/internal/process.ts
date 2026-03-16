export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
}

export interface CommandExecutionOptions {
  env?: Record<string, string | undefined>;
}

interface ProcessLike {
  env: Record<string, string | undefined>;
  versions: {
    node: string;
  };
}

interface DenoCommandLike {
  output(): Promise<{
    success: boolean;
    code: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
  }>;
}

interface DenoCommandCtor {
  new (
    command: string,
    options: {
      args: string[];
      env?: Record<string, string | undefined>;
      stdin: "null";
      stdout: "piped";
      stderr: "piped";
    },
  ): DenoCommandLike;
}

interface CommandOutputStream {
  on(event: "data", listener: (chunk: unknown) => void): void;
}

interface SpawnedCommandLike {
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
}

interface NodeChildProcessModuleLike {
  spawn(
    command: string,
    args: string[],
    options: {
      stdio: ["ignore", "pipe", "pipe"];
      env: Record<string, string | undefined>;
    },
  ): SpawnedCommandLike;
}

function isNodeChildProcessModuleLike(value: unknown): value is NodeChildProcessModuleLike {
  if (value == null || typeof value !== "object") {
    return false;
  }

  return "spawn" in value && typeof value.spawn === "function";
}

async function importModule(specifier: string): Promise<unknown> {
  return import(specifier);
}

function isRecordOfString(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

type GlobalProcess = { process?: { versions?: unknown; env?: unknown } };

function getProcess(): ProcessLike | undefined {
  const globalProcess = (globalThis as GlobalProcess).process;
  if (globalProcess == null || !isRecordOfString(globalProcess.versions) || !isRecordOfString(globalProcess.env)) {
    return undefined;
  }

  const versions = globalProcess.versions;
  if (!isRecordOfString(versions)) {
    return undefined;
  }

  const version = versions.node;
  if (typeof version !== "string") {
    return undefined;
  }

  const env = globalProcess.env;
  const processEnv: Record<string, string | undefined> = {};

  if (isRecordOfString(env)) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") {
        processEnv[key] = value;
      } else if (value == null) {
        processEnv[key] = undefined;
      }
    }
  }

  const processLike: ProcessLike = {
    env: processEnv,
    versions: {
      node: version,
    },
  };

  return processLike;
}

function getProcessEnv(): Record<string, string | undefined> {
  const process = getProcess();
  if (process == null) {
    return {};
  }

  return process.env;
}

function getDenoCommand(): DenoCommandCtor | undefined {
  const deno = globalThis as typeof globalThis & {
    Deno?: {
      Command?: DenoCommandCtor;
    };
  };

  return deno.Deno?.Command;
}

function hasNodeCompatibleCommandExecution(): boolean {
  const process = getProcess();
  return process != null && process.versions.node.length > 0;
}

export function hasCommandExecution(): boolean {
  return hasNodeCompatibleCommandExecution() || typeof getDenoCommand() === "function";
}

export function isCommandUnavailable(error: unknown): boolean {
  if (error == null || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: string }).code;
  return code === "ENOENT";
}

export async function executeCommand(
  command: string,
  args: string[],
  options: CommandExecutionOptions = {},
): Promise<CommandExecutionResult> {
  if (!hasCommandExecution()) {
    throw new Error("Command execution is unavailable");
  }

  const denoCommand = getDenoCommand();
  if (typeof denoCommand === "function") {
    const decoder = new TextDecoder();
    const child = new denoCommand(command, {
      args,
      env: options.env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });

    const result = await child.output();
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);

    if (!result.success) {
      rejectCommand(command, result.code, stdout, stderr);
    }

    return {
      stdout,
      stderr,
    };
  }

  if (!hasNodeCompatibleCommandExecution()) {
    throw new Error("Command execution is unavailable");
  }

  const childProcessModuleName = ["node", ["child", "process"].join("_")].join(":");
  const childProcess = await importModule(childProcessModuleName);
  if (!isNodeChildProcessModuleLike(childProcess)) {
    throw new Error("Command execution is unavailable");
  }

  return new Promise((resolve, reject) => {
    const processEnv = getProcessEnv();
    const child = childProcess.spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...processEnv,
        ...options.env,
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });

    child.on("error", (error: Error) => {
      reject(error);
    });

    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
        });
        return;
      }

      reject(new Error(`Command ${command} exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

function rejectCommand(command: string, code: number, stdout: string, stderr: string): never {
  throw new Error(`Command ${command} exited with code ${code}: ${stderr || stdout}`);
}
