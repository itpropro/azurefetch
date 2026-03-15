export function getAccountNameFromUrl(url: string): string {
  const parsedUrl = new URL(url);
  const hostParts = parsedUrl.hostname.split(".");

  if (hostParts[1] === "blob" || hostParts[1] === "table") {
    return hostParts[0] ?? "";
  }

  if (isIpEndpointStyle(parsedUrl)) {
    return parsedUrl.pathname.split("/").find((segment) => segment.length > 0) ?? "";
  }

  return "";
}

function isIpEndpointStyle(parsedUrl: URL): boolean {
  const host = parsedUrl.hostname;

  return host === "localhost" || host === "host.docker.internal" || /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}
