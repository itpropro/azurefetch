interface EnvironmentReader {
  get(name: string): string | undefined;
}

function createNodeEnvironmentReader(): EnvironmentReader | null {
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

export interface Environment {
  get: (name: string) => string | undefined;
}

export function getEnvironment(): Environment {
  const reader = createNodeEnvironmentReader();
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
