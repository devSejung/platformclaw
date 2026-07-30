import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonBodyReader } from "./browser-auth-http.js";
import type { KnoxRouteResolution, KnoxRoutingService } from "./knox-routing-service.js";

export const PLATFORMCLAW_KNOX_ROUTING_PATH = "/platformclaw/internal/knox/route";
const MAX_BODY_BYTES = 32 * 1024;

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function hasBearerToken(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const token = typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
  const actual = Buffer.from(token, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseRequest(value: unknown):
  | {
      ok: true;
      value: {
        accountId: string;
        conversationType: "dm" | "room";
        conversationId: string;
        knoxUserId: string;
      };
    }
  | { ok: false } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false };
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.accountId !== "string" ||
    (body.conversationType !== "dm" && body.conversationType !== "room") ||
    typeof body.conversationId !== "string" ||
    typeof body.knoxUserId !== "string" ||
    !body.accountId.trim() ||
    !body.conversationId.trim() ||
    !body.knoxUserId.trim()
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      accountId: body.accountId,
      conversationType: body.conversationType,
      conversationId: body.conversationId,
      knoxUserId: body.knoxUserId,
    },
  };
}

/** Handle one service-authenticated routing lookup from Knox plugin. */
export async function handlePlatformClawKnoxRoutingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: KnoxRoutingService;
    serviceToken: string;
    readJsonBody: JsonBodyReader;
  },
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== PLATFORMCLAW_KNOX_ROUTING_PATH) {
    return false;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }
  if (!hasBearerToken(req, options.serviceToken)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }
  const body = await options.readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    sendJson(res, 400, { ok: false, error: "invalid_request" });
    return true;
  }
  const parsed = parseRequest(body.value);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: "invalid_request" });
    return true;
  }
  let route: KnoxRouteResolution;
  try {
    route = await options.service.resolve(parsed.value);
  } catch {
    // A resolver exception is infrastructure failure, not a resolved product state.
    // Keeping these distinct lets the durable ingress retry instead of dropping the message.
    sendJson(res, 503, { ok: false, error: "routing_unavailable" });
    return true;
  }
  sendJson(res, route.status === "agent-unavailable" ? 503 : 200, { ok: true, ...route });
  return true;
}
