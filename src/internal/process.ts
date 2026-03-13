export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
}

export interface CommandExecutionOptions {
  env?: NodeJS.ProcessEnv;
}

function getProcessEnv(): NodeJS.ProcessEnv {
  if (typeof process === "undefined" || process.env == null) {
    return {};
  }

  return process.env;
}

export function hasCommandExecution(): boolean {
  return typeof process !== "undefined" && process.versions?.node != null;
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

  return await new Promise((resolve, reject) => {
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

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on("data", (chunk) => {
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
