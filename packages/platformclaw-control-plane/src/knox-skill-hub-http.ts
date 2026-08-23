import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonBodyReader } from "./browser-auth-http.js";
import { handlePlatformClawKnoxRoutingRequest } from "./knox-routing-http.js";
import type { KnoxRoutingService } from "./knox-routing-service.js";
import type { SkillHubService } from "./skill-hub-service.js";
import { SkillHubServiceError } from "./skill-hub-service.js";

export const PLATFORMCLAW_KNOX_SKILL_HUB_PATH = "/platformclaw/internal/knox/skillhub";
const MAX_BODY_BYTES = 16 * 1024;

function authorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actual = Buffer.from(token, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export async function handlePlatformClawKnoxSkillHubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: { service: SkillHubService; serviceToken: string; readJsonBody: JsonBodyReader },
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== PLATFORMCLAW_KNOX_SKILL_HUB_PATH) {
    return false;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    send(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!authorized(req, options.serviceToken)) {
    send(res, 401, { error: "unauthorized" });
    return true;
  }
  const read = await options.readJsonBody(req, MAX_BODY_BYTES);
  if (!read.ok || !read.value || typeof read.value !== "object" || Array.isArray(read.value)) {
    send(res, 400, { error: "invalid_request" });
    return true;
  }
  const body = read.value as Record<string, unknown>;
  if (typeof body.accountId !== "string" || typeof body.args !== "string") {
    send(res, 400, { error: "invalid_request" });
    return true;
  }
  try {
    send(res, 200, await options.service.command(body.accountId, body.args));
  } catch (error) {
    if (error instanceof SkillHubServiceError) {
      send(res, error.statusCode, {
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
      return true;
    }
    throw error;
  }
  return true;
}

export async function handlePlatformClawKnoxInternalRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: KnoxRoutingService;
    skillHubService?: SkillHubService;
    serviceToken: string;
    readJsonBody: JsonBodyReader;
  },
): Promise<boolean> {
  if (
    await handlePlatformClawKnoxRoutingRequest(req, res, {
      service: options.service,
      serviceToken: options.serviceToken,
      readJsonBody: options.readJsonBody,
    })
  ) {
    return true;
  }
  return options.skillHubService
    ? await handlePlatformClawKnoxSkillHubRequest(req, res, {
        service: options.skillHubService,
        serviceToken: options.serviceToken,
        readJsonBody: options.readJsonBody,
      })
    : false;
}
