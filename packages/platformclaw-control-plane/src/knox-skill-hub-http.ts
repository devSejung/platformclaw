import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonBodyReader } from "./browser-auth-http.js";
import { handlePlatformClawKnoxRoutingRequest } from "./knox-routing-http.js";
import type { KnoxRoutingService } from "./knox-routing-service.js";
import type { KnoxSkillHubCommandContext } from "./skill-hub-command-workspace.js";
import type { SkillHubService } from "./skill-hub-service.js";
import { SkillHubServiceError } from "./skill-hub-service.js";

const PLATFORMCLAW_KNOX_SKILL_HUB_PATH = "/platformclaw/internal/knox/skillhub";
const PLATFORMCLAW_ROOM_SKILL_POLICY_PATH = "/platformclaw/api/internal/skill-hub/room-skills";
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

async function handlePlatformClawKnoxSkillHubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service?: SkillHubService;
    routingService: KnoxRoutingService;
    serviceToken: string;
    readJsonBody: JsonBodyReader;
  },
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (
    pathname !== PLATFORMCLAW_KNOX_SKILL_HUB_PATH &&
    pathname !== PLATFORMCLAW_ROOM_SKILL_POLICY_PATH
  ) {
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
  const read = await options.readJsonBody(
    req,
    pathname === PLATFORMCLAW_ROOM_SKILL_POLICY_PATH ? 1024 * 1024 : MAX_BODY_BYTES,
  );
  if (!options.service && pathname !== PLATFORMCLAW_ROOM_SKILL_POLICY_PATH) {
    const english =
      read.ok &&
      read.value &&
      typeof read.value === "object" &&
      !Array.isArray(read.value) &&
      (read.value as Record<string, unknown>).locale === "en";
    send(res, 503, {
      error: english
        ? "Skill Hub is not enabled. Contact an administrator."
        : "Skill Hub이 활성화되어 있지 않습니다. 관리자에게 문의해 주세요.",
    });
    return true;
  }
  if (!read.ok || !read.value || typeof read.value !== "object" || Array.isArray(read.value)) {
    send(res, 400, { error: "invalid_request" });
    return true;
  }
  const body = read.value as Record<string, unknown>;
  if (pathname === PLATFORMCLAW_ROOM_SKILL_POLICY_PATH) {
    if (
      typeof body.agentId !== "string" ||
      !body.agentId ||
      body.agentId.length > 128 ||
      !Array.isArray(body.candidates) ||
      body.candidates.length > 2000 ||
      body.candidates.some((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          return true;
        }
        const value = candidate as Record<string, unknown>;
        return (
          typeof value.name !== "string" ||
          value.name.length > 512 ||
          typeof value.filePath !== "string" ||
          !value.filePath ||
          value.filePath.length > 4096 ||
          value.filePath.includes("\0") ||
          (value.sourceFilePath !== undefined &&
            (typeof value.sourceFilePath !== "string" ||
              !value.sourceFilePath ||
              value.sourceFilePath.length > 4096 ||
              value.sourceFilePath.includes("\0")))
        );
      })
    ) {
      send(res, 400, { error: "invalid_skill_policy_request" });
      return true;
    }
    if (!options.service) {
      if (await options.routingService.isActivePersonalAgent(body.agentId)) {
        send(res, 200, { excludedPaths: [] });
      } else {
        send(res, 503, { error: "Skill access could not be verified for this run" });
      }
      return true;
    }
    try {
      send(
        res,
        200,
        await options.service.roomSkills(
          body.agentId,
          body.candidates as Array<{
            name: string;
            filePath: string;
            sourceFilePath?: string;
          }>,
        ),
      );
    } catch (error) {
      send(res, error instanceof SkillHubServiceError ? error.statusCode : 503, {
        error: "Skill access could not be verified for this run",
      });
    }
    return true;
  }
  if (
    typeof body.accountId !== "string" ||
    (body.action === undefined && typeof body.args !== "string") ||
    (body.locale !== undefined && body.locale !== "ko" && body.locale !== "en")
  ) {
    send(res, 400, { error: "invalid_request" });
    return true;
  }
  const context = body.context as Record<string, unknown> | undefined;
  if (
    !context ||
    typeof context !== "object" ||
    Array.isArray(context) ||
    (context.conversationType !== "dm" && context.conversationType !== "room") ||
    ["accountId", "conversationId", "agentId", "sessionKey"].some(
      (key) => typeof context[key] !== "string" || !context[key].trim(),
    )
  ) {
    send(res, 400, { error: "invalid_command_context" });
    return true;
  }
  if (!options.service) {
    send(res, 503, { error: "Skill Hub is unavailable" });
    return true;
  }
  const action = body.action;
  const input = body.input as Record<string, unknown> | undefined;
  const allowedFields =
    action === "search"
      ? ["query"]
      : action === "status"
        ? ["slug"]
        : action === "delete"
          ? ["slug", "confirm"]
          : ["id", "version"];
  if (
    action !== undefined &&
    (typeof action !== "string" ||
      !["search", "status", "install", "delete"].includes(action) ||
      body.args !== undefined ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.entries(input).some(([key, value]) => {
        if (!allowedFields.includes(key)) {
          return true;
        }
        if (key === "confirm") {
          return value !== true;
        }
        return (
          typeof value !== "string" ||
          value.length > (key === "query" ? 1000 : 128) ||
          (key !== "query" && !value.trim())
        );
      }) ||
      (action === "install" &&
        allowedFields.some((key) => typeof input[key] !== "string" || !input[key].trim())) ||
      (action === "delete" &&
        (typeof input.slug !== "string" || !input.slug.trim() || input.confirm !== true)))
  ) {
    send(res, 400, { error: "invalid_tool_request" });
    return true;
  }
  try {
    const commandContext: KnoxSkillHubCommandContext = {
      accountId: context.accountId as string,
      conversationType: context.conversationType,
      conversationId: context.conversationId as string,
      agentId: context.agentId as string,
      sessionKey: context.sessionKey as string,
    };
    send(
      res,
      200,
      action === undefined
        ? await options.service.knoxCommand(
            body.accountId,
            body.args as string,
            body.locale ?? "en",
            commandContext,
          )
        : await options.service.knoxTool(
            body.accountId,
            action as "search" | "status" | "install" | "delete",
            input as {
              query?: string;
              id?: string;
              slug?: string;
              version?: string;
              confirm?: boolean;
            },
            commandContext,
          ),
    );
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
  return await handlePlatformClawKnoxSkillHubRequest(req, res, {
    service: options.skillHubService,
    routingService: options.service,
    serviceToken: options.serviceToken,
    readJsonBody: options.readJsonBody,
  });
}
