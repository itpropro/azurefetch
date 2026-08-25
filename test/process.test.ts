import { afterEach, describe, expect, test, vi } from "vitest";

import { executeCommand } from "../src/internal/process";

interface TestDenoRuntime {
  Command?: new (
    command: string,
    options: {
      args: string[];
      env?: Record<string, string | undefined>;
      stdin: "null";
      stdout: "piped";
      stderr: "piped";
    },
  ) => {
    spawn(): {
      output(): Promise<{
        success: boolean;
        code: number;
        stdout: Uint8Array;
        stderr: Uint8Array;
      }>;
      kill(signo?: string): void;
    };
  };
}

const runtime = globalThis as typeof globalThis & { Deno?: TestDenoRuntime };
const originalDeno = runtime.Deno;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDeno === undefined) {
    delete runtime.Deno;
  } else {
    runtime.Deno = originalDeno;
  }
});

describe("executeCommand cancellation", () => {
  test("does not create a process for an already-aborted signal", async () => {
    const construct = vi.fn();
    const reason = new Error("cancelled before spawn");
    runtime.Deno = {
      Command: class {
        constructor() {
          construct();
        }

        spawn() {
          throw new Error("spawn must not run");
        }
      },
    };

    await expect(executeCommand("az", [], { abortSignal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(construct).not.toHaveBeenCalled();
  });

  test("terminates an active Node-compatible process and removes its abort listener", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const reason = new Error("cancelled node process");
    const command = executeCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      abortSignal: controller.signal,
    });

    setTimeout(() => controller.abort(reason), 20);

    await expect(command).rejects.toBe(reason);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("terminates an active Deno process and removes its abort listener", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const reason = new Error("cancelled deno process");
    const kill = vi.fn();
    let finish:
      | ((result: { success: boolean; code: number; stdout: Uint8Array; stderr: Uint8Array }) => void)
      | undefined;

    runtime.Deno = {
      Command: class {
        spawn() {
          return {
            output: () =>
              new Promise<{
                success: boolean;
                code: number;
                stdout: Uint8Array;
                stderr: Uint8Array;
              }>((resolve) => {
                finish = resolve;
              }),
            kill: (signo?: string) => {
              kill(signo);
              finish?.({
                success: false,
                code: 143,
                stdout: new Uint8Array(),
                stderr: new Uint8Array(),
              });
            },
          };
        }
      },
    };

    const command = executeCommand("az", [], { abortSignal: controller.signal });
    await Promise.resolve();
    controller.abort(reason);

    await expect(command).rejects.toBe(reason);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("removes the abort listener after successful Node-compatible execution", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    await expect(
      executeCommand(process.execPath, ["-e", "process.stdout.write('ok')"], {
        abortSignal: controller.signal,
      }),
    ).resolves.toEqual({ stdout: "ok", stderr: "" });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("removes the abort listener after successful Deno execution", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const kill = vi.fn();
    const encoder = new TextEncoder();
    runtime.Deno = {
      Command: class {
        spawn() {
          return {
            output: () =>
              Promise.resolve({
                success: true,
                code: 0,
                stdout: encoder.encode("ok"),
                stderr: new Uint8Array(),
              }),
            kill,
          };
        }
      },
    };

    await expect(executeCommand("az", [], { abortSignal: controller.signal })).resolves.toEqual({
      stdout: "ok",
      stderr: "",
    });
    expect(kill).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
