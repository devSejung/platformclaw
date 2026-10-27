import type { ResponseFrame } from "@openclaw/gateway-protocol";
import { reportBrowserGatewayRequestFailure } from "./browser-gateway-errors.js";

export function responseError(
  id: string,
  error: unknown,
  context = { method: "connect", elapsedMs: 0 },
): ResponseFrame {
  return { type: "res", id, ok: false, error: reportBrowserGatewayRequestFailure(error, context) };
}

export function responseOk(id: string, payload: unknown): ResponseFrame {
  return { type: "res", id, ok: true, payload };
}
