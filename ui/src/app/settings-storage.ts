import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { normalizeGatewayTokenScope } from "./gateway-scope.ts";

const SETTINGS_KEY_PREFIX = "openclaw.control.settings.v1:";
const CURRENT_GATEWAY_SELECTION_KEY_PREFIX = "openclaw.control.currentGateway.v1:";

export function settingsKeyForGateway(gatewayUrl: string): string {
  return `${SETTINGS_KEY_PREFIX}${normalizeGatewayTokenScope(gatewayUrl)}`;
}

export function currentGatewaySelectionKeyForPage(pageUrl: string): string {
  return `${CURRENT_GATEWAY_SELECTION_KEY_PREFIX}${normalizeGatewayTokenScope(pageUrl)}`;
}

function isViteDevPage(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return Boolean(document.querySelector('script[src*="/@vite/client"]'));
}

function formatHostWithPort(hostname: string, port: string): string {
  // location.hostname already carries brackets for IPv6 literals; wrapping
  // again would produce an undialable ws://[[::1]]:port default.
  const needsBrackets = hostname.includes(":") && !hostname.startsWith("[");
  const normalizedHost = needsBrackets ? `[${hostname}]` : hostname;
  return `${normalizedHost}:${port}`;
}

export function deriveDefaultGatewayUrl(basePath: string): {
  pageUrl: string;
  effectiveUrl: string;
} {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const pageUrl = `${proto}://${location.host}${basePath}`;
  if (!isViteDevPage()) {
    return { pageUrl, effectiveUrl: pageUrl };
  }
  const effectiveUrl = `${proto}://${formatHostWithPort(location.hostname, "18789")}`;
  return { pageUrl, effectiveUrl };
}

// Appearance bootstrap and the full app must select the same scoped record;
// scanning storage can apply another Gateway's preferences before first paint.
export function readSelectedSettings(storage: Storage | null, pageUrl: string, defaultUrl: string) {
  const selectedGatewayUrl = normalizeOptionalString(
    storage?.getItem(currentGatewaySelectionKeyForPage(pageUrl)),
  );
  const selected = selectedGatewayUrl ? readSettingsForGateway(storage, selectedGatewayUrl) : null;
  return selected ?? readSettingsForGateway(storage, defaultUrl);
}

export function readSettingsForGateway(
  storage: Storage | null,
  targetUrl: string,
): { gatewayUrl: string; parsed: Record<string, unknown> } | null {
  const raw = storage?.getItem(settingsKeyForGateway(targetUrl));
  if (!raw) {
    return null;
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asNullableRecord(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!parsed) {
    return null;
  }
  const gatewayUrl = normalizeOptionalString(parsed.gatewayUrl) ?? targetUrl;
  if (normalizeGatewayTokenScope(gatewayUrl) !== normalizeGatewayTokenScope(targetUrl)) {
    return null;
  }
  return { gatewayUrl, parsed };
}
