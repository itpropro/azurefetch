export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
}

export interface CommandExecutionOptions {
  env?: NodeJS.ProcessEnv;
}

interface ProcessLike {
  env: Record<string, string | undefined>;
  versions: {
    node: string;
  };
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
      if (value == null || typeof value === "string") {
        processEnv[key] = value;
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

function getProcessEnv(): NodeJS.ProcessEnv {
  const process = getProcess();
  if (process == null) {
    return {};
  }

  return process.env;
}

export function hasCommandExecution(): boolean {
  const process = getProcess();
  return process != null && process.versions.node.length > 0;
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

  const childProcess = await import("node:child_process");
  const { spawn } = childProcess;

  return new Promise((resolve, reject) => {
    const processEnv = getProcessEnv();
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...processEnv,
        ...options.env,
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
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
