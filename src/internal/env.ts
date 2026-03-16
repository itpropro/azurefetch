interface EnvironmentReader {
  get(name: string): string | undefined;
}

function createProcessEnvironmentReader(): EnvironmentReader | null {
  if (typeof process === "undefined") {
    return null;
  }

  const proc = process as {
    env?: Record<string, string | undefined>;
  };

  if (proc.env == null) {
    return null;
  }

  return {
    get(name: string) {
      return proc.env?.[name];
    },
  };
}

function createDenoEnvironmentReader(): EnvironmentReader | null {
  const deno = globalThis as typeof globalThis & {
    Deno?: {
      env?: {
        get(name: string): string | undefined;
      };
    };
  };

  if (typeof deno.Deno?.env?.get !== "function") {
    return null;
  }

  return {
    get(name: string) {
      return deno.Deno?.env?.get(name);
    },
  };
}

export interface Environment {
  get: (name: string) => string | undefined;
}

export function getEnvironment(): Environment {
  const reader = createProcessEnvironmentReader() ?? createDenoEnvironmentReader();
  if (reader == null) {
    return {
      get() {
        return undefined;
      },
    };
  }

  return {
    get(name: string) {
      return reader.get(name);
    },
  };
}

export function getEnv(environment: Environment, name: string): string | undefined {
  const value = environment.get(name);

  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
