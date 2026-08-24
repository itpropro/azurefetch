export function sanitizeAuthorityHost(authorityHost: string): string {
  const trimmed = authorityHost.trim();
  requireHttpsUrl(trimmed, "authorityHost");

  return trimmed.replace(/\/+$/, "");
}

export function requireHttpsUrl(input: string, name: string): URL {
  const url = new URL(input);
  if (url.protocol !== "https:") {
    throw new TypeError(`${name} must use HTTPS`);
  }

  return url;
}

export function joinPath(base: string, path: string): string {
  if (base.endsWith("/") && path.startsWith("/")) {
    return base + path.slice(1);
  }

  if (!base.endsWith("/") && !path.startsWith("/")) {
    return `${base}/${path}`;
  }

  return base + path;
}
