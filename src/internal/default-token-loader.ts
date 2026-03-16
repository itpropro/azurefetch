import type { AccessToken } from "../types";

export interface DefaultTokenLoaderInput {
  scope: string | string[];
  authorityHost?: string;
  fetch: typeof globalThis.fetch;
}

type DefaultTokenLoader = (input: DefaultTokenLoaderInput) => Promise<AccessToken>;

let defaultTokenLoader: DefaultTokenLoader | undefined;

export function setDefaultTokenLoader(loader: DefaultTokenLoader | undefined): void {
  defaultTokenLoader = loader;
}

export async function loadDefaultToken(input: DefaultTokenLoaderInput): Promise<AccessToken> {
  if (defaultTokenLoader == null) {
    throw new Error(
      "No default Azure credential loader is configured. Import the package root or provide a credential.",
    );
  }

  return defaultTokenLoader(input);
}
