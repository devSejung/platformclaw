const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap/";

export type CanvasPluginSurfaceRoute =
  | { mode: "direct" }
  | { mode: "relay-waiting"; reason: "connecting" | "unavailable" }
  | { mode: "relay-ready"; baseUrl: string };

/** Accept only the document-free capability URL issued by the Canvas BFF. */
export function normalizeCanvasRelaySurfaceUrl(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate || candidate.includes("?") || candidate.includes("#")) {
    return null;
  }
  try {
    const url = new URL(candidate);
    const ticket = url.pathname.startsWith(CANVAS_CAPABILITY_PATH_PREFIX)
      ? url.pathname.slice(CANVAS_CAPABILITY_PATH_PREFIX.length)
      : "";
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !ticket ||
      ticket.includes("/")
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

export function createCanvasPluginSurfaceRoute(
  value: string | null | undefined,
  relayRequired: boolean,
  reason: "connecting" | "unavailable",
): CanvasPluginSurfaceRoute {
  const baseUrl = normalizeCanvasRelaySurfaceUrl(value);
  if (baseUrl) {
    return { mode: "relay-ready", baseUrl };
  }
  return relayRequired ? { mode: "relay-waiting", reason } : { mode: "direct" };
}
