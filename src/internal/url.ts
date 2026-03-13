export function sanitizeAuthorityHost(authorityHost: string): string {
  const trimmed = authorityHost.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new TypeError("authorityHost must start with http:// or https://");
  }

  return trimmed.replace(/\/+$/, "");
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
