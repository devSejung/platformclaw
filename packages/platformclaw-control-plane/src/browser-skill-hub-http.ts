import { mkdtemp, open, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import { sendBrowserJson } from "./browser-http-shared.js";
import {
  SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
  SkillHubService,
  SkillHubServiceError,
} from "./skill-hub-service.js";

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

function booleanField(body: Record<string, unknown>, name: string): boolean {
  if (typeof body[name] !== "boolean") {
    throw new SkillHubServiceError(`${name} must be a boolean`, 400);
  }
  return body[name];
}

function optionalBoolean(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new SkillHubServiceError(`${name} must be a boolean`, 400);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new SkillHubServiceError(`${name} must be a non-empty string`, 400);
  }
  return value.trim();
}

function optionalInteger(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value)) {
    throw new SkillHubServiceError(`${name} must be an integer`, 400);
  }
  return value as number;
}

async function readZipBody(
  req: IncomingMessage,
): Promise<{ path: string; size: number; cleanup(): Promise<void> }> {
  if ((req.headers["content-type"] ?? "").split(";", 1)[0]?.trim() !== "application/zip") {
    throw new SkillHubServiceError("ZIP upload requires application/zip", 415);
  }
  const declared = req.headers["content-length"];
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > SKILL_HUB_UPLOAD_ARCHIVE_BYTES)) {
    throw new SkillHubServiceError("Skill Hub ZIP exceeds the 500 MiB upload limit", 413);
  }
  const directory = await mkdtemp(path.join(tmpdir(), "platformclaw-skill-hub-upload-"));
  const archivePath = path.join(directory, "archive.zip");
  const handle = await open(archivePath, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.byteLength;
      if (bytes > SKILL_HUB_UPLOAD_ARCHIVE_BYTES) {
        req.resume();
        throw new SkillHubServiceError("Skill Hub ZIP exceeds the 500 MiB upload limit", 413);
      }
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  await handle.close();
  return {
    path: archivePath,
    size: bytes,
    cleanup: async () => await rm(directory, { recursive: true, force: true }),
  };
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
      ...(error instanceof SkillHubServiceError && error.details ? { details: error.details } : {}),
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
        sendBrowserJson(res, 200, await options.service.config(actor));
        return true;
      }
      if (url.pathname === `${PLATFORMCLAW_SKILL_HUB_PATH}/notifications`) {
        const rawLimit = url.searchParams.get("limit");
        sendBrowserJson(
          res,
          200,
          await options.service.notifications(
            actor.user,
            rawLimit === null ? 50 : Number(rawLimit),
          ),
        );
        return true;
      }
      if (url.pathname === `${PLATFORMCLAW_SKILL_HUB_PATH}/admin/unassigned`) {
        sendBrowserJson(res, 200, await options.service.unassignedSkills(actor.user));
        return true;
      }
      if (url.pathname === `${PLATFORMCLAW_SKILL_HUB_PATH}/admin/namespaces`) {
        sendBrowserJson(res, 200, await options.service.namespaceBindings(actor.user));
        return true;
      }
      const accessMatch = new RegExp(
        `^${PLATFORMCLAW_SKILL_HUB_PATH}/skills/([^/]+)/([^/]+)/access$`,
        "u",
      ).exec(url.pathname);
      if (accessMatch) {
        sendBrowserJson(
          res,
          200,
          await options.service.listAccess(
            actor.user,
            decodeSegment(accessMatch[1]!),
            decodeSegment(accessMatch[2]!),
          ),
        );
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
      if (url.pathname === `${PLATFORMCLAW_SKILL_HUB_PATH}/publish/upload`) {
        const archive = await readZipBody(req);
        try {
          const result = await options.service.publishArchive(
            actor,
            {
              slug: url.searchParams.get("slug") ?? "",
              namespace: url.searchParams.get("namespace") ?? "",
              version: url.searchParams.get("version") ?? "",
              visibility: url.searchParams.get("visibility") ?? "",
            },
            archive,
          );
          sendBrowserJson(res, 200, result);
        } finally {
          await archive.cleanup();
        }
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
            destination: executionTargetField(body, "destination"),
            acknowledgedVersionChange: optionalBoolean(body, "acknowledgedVersionChange"),
            currentVersion: optionalString(body, "currentVersion"),
          }),
        );
        return true;
      }
      if (url.pathname === `${PLATFORMCLAW_SKILL_HUB_PATH}/notifications/read`) {
        const ids = body.ids;
        if (
          ids !== undefined &&
          (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
        ) {
          throw new SkillHubServiceError("ids must be an array of strings", 400);
        }
        sendBrowserJson(
          res,
          200,
          await options.service.markNotificationsRead(actor.user, ids as string[] | undefined),
        );
        return true;
      }
      const ownerMatch = new RegExp(
        `^${PLATFORMCLAW_SKILL_HUB_PATH}/skills/([^/]+)/([^/]+)/owner$`,
        "u",
      ).exec(url.pathname);
      if (ownerMatch) {
        sendBrowserJson(
          res,
          200,
          await options.service.transferOwner(
            actor.user,
            decodeSegment(ownerMatch[1]!),
            decodeSegment(ownerMatch[2]!),
            stringField(body, "ownerUserId"),
          ),
        );
        return true;
      }
      const accessMatch = new RegExp(
        `^${PLATFORMCLAW_SKILL_HUB_PATH}/skills/([^/]+)/([^/]+)/access$`,
        "u",
      ).exec(url.pathname);
      if (accessMatch) {
        sendBrowserJson(
          res,
          200,
          await options.service.setAccess(
            actor.user,
            decodeSegment(accessMatch[1]!),
            decodeSegment(accessMatch[2]!),
            {
              userId: stringField(body, "userId"),
              ...(optionalInteger(body, "expiresAt") === undefined
                ? {}
                : { expiresAt: optionalInteger(body, "expiresAt") }),
              inheritVersions: booleanField(body, "inheritVersions"),
              ...(typeof body.version === "string" ? { version: body.version } : {}),
            },
          ),
        );
        return true;
      }
      const forceMatch = new RegExp(
        `^${PLATFORMCLAW_SKILL_HUB_PATH}/skills/([^/]+)/([^/]+)/force$`,
        "u",
      ).exec(url.pathname);
      if (forceMatch) {
        sendBrowserJson(
          res,
          200,
          await options.service.acknowledgeForcePublish(
            actor.user,
            decodeSegment(forceMatch[1]!),
            decodeSegment(forceMatch[2]!),
            {
              version: stringField(body, "version"),
              acknowledged: booleanField(body, "acknowledged"),
              reason: stringField(body, "reason"),
            },
          ),
        );
        return true;
      }
      if (url.pathname === `${PLATFORMCLAW_SKILL_HUB_PATH}/admin/namespaces`) {
        const scopeKind = stringField(body, "scopeKind");
        if (
          scopeKind !== "global" &&
          scopeKind !== "team" &&
          scopeKind !== "group" &&
          scopeKind !== "part"
        ) {
          throw new SkillHubServiceError("invalid namespace scope kind", 400);
        }
        sendBrowserJson(
          res,
          200,
          await options.service.setNamespaceBinding(actor.user, {
            namespace: stringField(body, "namespace"),
            scopeKind,
            ...(typeof body.scopeId === "string" ? { scopeId: body.scopeId } : {}),
            visibilityCeiling: stringField(body, "visibilityCeiling"),
          }),
        );
        return true;
      }
    }
    if (method === "DELETE") {
      if (!options.isMutationOriginAllowed(req)) {
        sendBrowserJson(res, 403, { error: "origin not allowed" });
        return true;
      }
      const accessMatch = new RegExp(
        `^${PLATFORMCLAW_SKILL_HUB_PATH}/skills/([^/]+)/([^/]+)/access/([^/]+)$`,
        "u",
      ).exec(url.pathname);
      if (accessMatch) {
        sendBrowserJson(
          res,
          200,
          await options.service.removeAccess(
            actor.user,
            decodeSegment(accessMatch[1]!),
            decodeSegment(accessMatch[2]!),
            decodeSegment(accessMatch[3]!),
          ),
        );
        return true;
      }
      const namespaceMatch = new RegExp(
        `^${PLATFORMCLAW_SKILL_HUB_PATH}/admin/namespaces/([^/]+)$`,
        "u",
      ).exec(url.pathname);
      if (namespaceMatch) {
        sendBrowserJson(
          res,
          200,
          await options.service.removeNamespaceBinding(
            actor.user,
            decodeSegment(namespaceMatch[1]!),
          ),
        );
        return true;
      }
    }
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST, DELETE");
    res.end("Method Not Allowed");
  } catch (error) {
    const status = error instanceof SkillHubServiceError ? error.statusCode : 503;
    sendBrowserJson(res, status, {
      error: error instanceof Error ? error.message : "request failed",
      ...(error instanceof SkillHubServiceError && error.details ? { details: error.details } : {}),
    });
  }
  return true;
}

function executionTargetField(
  body: Record<string, unknown>,
  key: string,
): "platform_server" | "assigned_vm" {
  const value = stringField(body, key);
  if (value !== "platform_server" && value !== "assigned_vm") {
    throw new SkillHubServiceError("invalid install destination", 400);
  }
  return value;
}
