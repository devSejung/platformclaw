import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import { sendBrowserJson } from "./browser-http-shared.js";
import { SkillHubService, SkillHubServiceError } from "./skill-hub-service.js";

export const PLATFORMCLAW_SKILL_HUB_PATH = "/platformclaw/api/skill-hub";
const BODY_LIMIT_BYTES = 16 * 1024;

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillHubServiceError("invalid request body", 400);
  }
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new SkillHubServiceError(`${name} is required`, 400);
  }
  return value.trim();
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SkillHubServiceError("invalid request path", 400);
  }
}

export async function handlePlatformClawSkillHubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: SkillHubService;
    readJsonBody: JsonBodyReader;
    isMutationOriginAllowed(req: IncomingMessage): boolean;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (
    url.pathname !== PLATFORMCLAW_SKILL_HUB_PATH &&
    !url.pathname.startsWith(`${PLATFORMCLAW_SKILL_HUB_PATH}/`)
  ) {
    return false;
  }
  const token = readPlatformClawSessionCookie(req);
  let actor;
  try {
    actor = token ? await options.service.authenticate(token) : null;
  } catch (error) {
    const status = error instanceof SkillHubServiceError ? error.statusCode : 503;
    sendBrowserJson(res, status, {
      error: error instanceof Error ? error.message : "request failed",
    });
    return true;
  }
  if (!actor) {
    sendBrowserJson(res, 401, { error: "authentication required" });
    return true;
  }
  const method = (req.method ?? "GET").toUpperCase();
  try {
    if (method === "GET") {
      if (url.pathname === `${PLATFORMCLAW_SKILL_HUB_PATH}/config`) {
        sendBrowserJson(res, 200, options.service.config(actor.user));
        return true;
      }
      if (url.pathname === `${PLATFORMCLAW_SKILL_HUB_PATH}/search`) {
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 20 : Number(rawLimit);
        sendBrowserJson(
          res,
          200,
          await options.service.search(actor.user, url.searchParams.get("q") ?? "", limit),
        );
        return true;
      }
      const match = new RegExp(`^${PLATFORMCLAW_SKILL_HUB_PATH}/skills/([^/]+)/([^/]+)$`, "u").exec(
        url.pathname,
      );
      if (match) {
        sendBrowserJson(
          res,
          200,
          await options.service.detail(
            actor.user,
            decodeSegment(match[1]!),
            decodeSegment(match[2]!),
          ),
        );
        return true;
      }
    }
    if (method === "POST") {
      if (!options.isMutationOriginAllowed(req)) {
        sendBrowserJson(res, 403, { error: "origin not allowed" });
        return true;
      }
      const read = await options.readJsonBody(req, BODY_LIMIT_BYTES);
      if (!read.ok) {
        sendBrowserJson(res, 400, { error: read.error });
        return true;
      }
      const body = objectBody(read.value);
      if (url.pathname === `${PLATFORMCLAW_SKILL_HUB_PATH}/publish`) {
        sendBrowserJson(
          res,
          200,
          await options.service.publish(actor, {
            skill: stringField(body, "skill"),
            namespace: stringField(body, "namespace"),
            version: stringField(body, "version"),
            visibility: stringField(body, "visibility"),
          }),
        );
        return true;
      }
      if (url.pathname === `${PLATFORMCLAW_SKILL_HUB_PATH}/install`) {
        sendBrowserJson(
          res,
          200,
          await options.service.install(actor, {
            namespace: stringField(body, "namespace"),
            slug: stringField(body, "slug"),
            version: stringField(body, "version"),
          }),
        );
        return true;
      }
    }
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
  } catch (error) {
    const status = error instanceof SkillHubServiceError ? error.statusCode : 503;
    sendBrowserJson(res, status, {
      error: error instanceof Error ? error.message : "request failed",
    });
  }
  return true;
}
