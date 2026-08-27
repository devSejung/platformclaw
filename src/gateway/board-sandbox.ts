import { buildSandboxHostPath } from "../agents/sandbox-host.js";
import type { BoardWidgetHtmlViewMetadata } from "../boards/board-store.js";

type BoardWidgetSandboxMetadata = Pick<BoardWidgetHtmlViewMetadata, "declared" | "grantState">;

function grantedConnectOrigins(document: BoardWidgetSandboxMetadata): string[] | undefined {
  if (document.grantState !== "granted") {
    return undefined;
  }
  const origins = document.declared?.netOrigins;
  return origins?.length ? origins : undefined;
}

export function buildBoardWidgetSandboxPath(document: BoardWidgetSandboxMetadata): string {
  const connectDomains = grantedConnectOrigins(document);
  return buildSandboxHostPath({
    // Best-effort hardening for the documented WebRTC residual; the DOM guard
    // reduces fresh descendant realms but is not an authorization boundary.
    blockDescendantFrames: true,
    // Board HTML is already limited to data/blob images by its inner wrapper.
    // The srcdoc inherits this outer CSP, so it must preserve the same blob source.
    allowBlobImages: true,
    ...(connectDomains ? { connectDomains } : {}),
  });
}

/** Defense in depth for direct/legacy widget document loads outside the proxy host. */
export function buildBoardWidgetContentSecurityPolicy(
  document: BoardWidgetSandboxMetadata,
): string {
  const connectSources = grantedConnectOrigins(document)?.join(" ") ?? "'none'";
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    `connect-src ${connectSources}`,
    "webrtc 'block'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "sandbox allow-scripts",
  ].join("; ");
}
