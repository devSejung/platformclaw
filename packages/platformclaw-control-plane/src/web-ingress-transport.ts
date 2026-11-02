import type { Duplex } from "node:stream";

/** Validate the listener origin once before browser and Gateway traffic share it. */
export function normalizeWebIngressOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PlatformClaw public origin must use http or https");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "PlatformClaw public origin must not include credentials, path, query, or hash",
    );
  }
  return parsed.origin;
}

/** Upgrade failures still need a complete HTTP response before the socket closes. */
export function rejectWebIngressUpgrade(
  socket: Duplex,
  statusCode: number,
  statusText: string,
): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}
