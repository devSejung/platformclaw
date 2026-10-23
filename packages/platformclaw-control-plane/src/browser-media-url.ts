import { createHash } from "node:crypto";
import {
  BrowserGatewayProxyError,
  type BrowserGatewayAccess,
} from "./browser-gateway-contracts.js";

/** Cache identity only; the relay still requires the current cookie and media ticket. */
export function scopeBrowserMediaDownloadUrl(
  value: string,
  access: Pick<BrowserGatewayAccess, "binding" | "session">,
): string {
  if (!value.startsWith("/api/chat/media/outgoing/")) {
    return value;
  }
  if (!access.session) {
    throw new BrowserGatewayProxyError("unauthenticated", "active browser session required");
  }
  const url = new URL(value, "http://platformclaw.invalid");
  // Clear-Site-Data clears network cache but Chromium can retain decoded images.
  // A login-specific key prevents the app from reusing a previous login's entry,
  // including responses cached before the browser relay adopted no-store.
  url.searchParams.set(
    "browserSession",
    createHash("sha256").update(`${access.binding.agentId}\0${access.session.id}`).digest("hex"),
  );
  return `${url.pathname}${url.search}${url.hash}`;
}
