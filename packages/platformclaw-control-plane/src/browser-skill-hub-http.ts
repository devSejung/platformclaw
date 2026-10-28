import { mkdtemp, open, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import { sendBrowserJson } from "./browser-http-shared.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
} from "./contracts.js";
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

function integerField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (!Number.isSafeInteger(value)) {
    throw new SkillHubServiceError(`${name} must be an integer`, 400);
  }
  return value as number;
}

function sendSkillHubError(res: ServerResponse, error: unknown): void {
  const status =
    error instanceof SkillHubServiceError
      ? error.statusCode
      : error instanceof ControlPlaneConflictError
        ? 409
        : error instanceof ControlPlaneAuthorizationError
          ? 403
          : error instanceof ControlPlaneNotFoundError
            ? 404
            : error instanceof ControlPlaneStateError
              ? 400
              : 503;
  sendBrowserJson(res, status, {
    error: error instanceof Error ? error.message : "request failed",
    ...(error instanceof SkillHubServiceError && error.details ? { details: error.details } : {}),
    ...(error instanceof ControlPlaneConflictError ? { details: { code: error.code } } : {}),
  });
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

function stringArray(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string") ||
    value.length > 100
  ) {
    throw new SkillHubServiceError(`${name} must be an array of strings`, 400);
  }
  return value as string[];
}

function sharingValue(
  value: unknown,
): import("./skill-hub-catalog-state.js").SkillHubSharing | undefined {
  if (value === undefined) {
    return undefined;
  }
  const sharing = objectBody(value);
  if (sharing.mode !== "PUBLIC" && sharing.mode !== "SELECTED" && sharing.mode !== "PRIVATE") {
    throw new SkillHubServiceError("Invalid sharing mode", 400);
  }
  return {
    mode: sharing.mode,
    userIds: sharing.userIds === undefined ? [] : stringArray(sharing.userIds, "userIds"),
    scopeIds: sharing.scopeIds === undefined ? [] : stringArray(sharing.scopeIds, "scopeIds"),
  };
}

async function readIconBody(
  req: IncomingMessage,
): Promise<import("./skill-hub-catalog-state.js").SkillHubCatalogIcon> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.byteLength;
    if (size > 2 * 1024 * 1024) {
      req.resume();
      throw new SkillHubServiceError("Icon must be 2 MB or smaller", 413);
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  const type = (req.headers["content-type"] ?? "").split(";", 1)[0];
  const png =
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR";
  const jpeg =
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217;
  const webp =
    bytes.length >= 16 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP" &&
    bytes.readUInt32LE(4) === bytes.length - 8;
  const contentType =
    type === "image/png" && png
      ? "image/png"
      : type === "image/jpeg" && jpeg
        ? "image/jpeg"
        : type === "image/webp" && webp
          ? "image/webp"
          : null;
  if (contentType) {
    return { contentType, bytes };
  }
  throw new SkillHubServiceError("Choose a PNG, JPEG, or WebP image", 415);
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
  try {
    const token = readPlatformClawSessionCookie(req);
    const actor = token ? await options.service.authenticate(token) : null;
    if (!actor) {
      sendBrowserJson(res, 401, { error: "authentication required" });
      return true;
    }
    const method = (req.method ?? "GET").toUpperCase();
    const parts = url.pathname
      .slice(PLATFORMCLAW_SKILL_HUB_PATH.length)
      .split("/")
      .filter(Boolean)
      .map(decodeSegment);
    const route = parts.join("/");
    if (method !== "GET" && !options.isMutationOriginAllowed(req)) {
      sendBrowserJson(res, 403, { error: "request origin is not allowed" });
      return true;
    }
    const json = async () => {
      const read = await options.readJsonBody(req, BODY_LIMIT_BYTES);
      if (!read.ok) {
        throw new SkillHubServiceError(read.error, 400);
      }
      return objectBody(read.value);
    };
    if (method === "GET") {
      if (route === "config") {
        sendBrowserJson(res, 200, await options.service.config(actor));
      } else if (route === "search") {
        sendBrowserJson(
          res,
          200,
          await options.service.search(
            actor.user,
            url.searchParams.get("q") ?? "",
            Number(url.searchParams.get("limit") ?? 50),
          ),
        );
      } else if (route === "users") {
        sendBrowserJson(
          res,
          200,
          await options.service.users(actor.user, url.searchParams.get("q") ?? ""),
        );
      } else if (route === "trash") {
        sendBrowserJson(res, 200, await options.service.trash(actor.user));
      } else if (route === "transfers") {
        sendBrowserJson(res, 200, await options.service.transfers(actor.user));
      } else if (route === "notifications") {
        sendBrowserJson(
          res,
          200,
          await options.service.notifications(
            actor.user,
            Number(url.searchParams.get("limit") ?? 50),
          ),
        );
      } else if (route === "workspace-skills") {
        const source = url.searchParams.get("source");
        if (source !== "platform_server" && source !== "assigned_vm") {
          throw new SkillHubServiceError("Invalid workspace source", 400);
        }
        sendBrowserJson(res, 200, await options.service.workspaceSkills(actor, source));
      } else if (parts[0] === "skills" && parts[1] === "by-id" && parts[2]) {
        const id = parts[2];
        if (parts.length === 3) {
          sendBrowserJson(res, 200, await options.service.detailById(actor.user, id));
        } else if (parts.length === 4 && parts[3] === "history") {
          sendBrowserJson(res, 200, await options.service.history(actor.user, id));
        } else if (parts.length === 4 && parts[3] === "icon") {
          const icon = await options.service.icon(actor.user, id);
          res.writeHead(200, {
            "Content-Type": icon.contentType,
            "Content-Length": icon.bytes.byteLength,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
          });
          res.end(icon.bytes);
        } else if (parts.length === 4 && parts[3] === "download") {
          const download = await options.service.download(
            actor.user,
            id,
            url.searchParams.get("version") ?? "",
          );
          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Length": download.archive.byteLength,
            "Content-Disposition": `attachment; filename="${download.filename}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(download.archive);
        } else {
          sendBrowserJson(res, 404, { error: "not found" });
        }
      } else if (parts[0] === "skills" && parts.length === 3) {
        // Preserve existing published links; coordinate inputs resolve the same canonical ID.
        sendBrowserJson(res, 200, await options.service.detail(actor.user, parts[1]!, parts[2]!));
      } else {
        sendBrowserJson(res, 404, { error: "not found" });
      }
      return true;
    }
    if (method === "POST" && route === "publish/upload") {
      let sharing;
      try {
        sharing = sharingValue(
          url.searchParams.has("sharing")
            ? JSON.parse(url.searchParams.get("sharing")!)
            : undefined,
        );
      } catch {
        throw new SkillHubServiceError("Invalid upload sharing settings", 400);
      }
      const archive = await readZipBody(req);
      try {
        sendBrowserJson(
          res,
          200,
          await options.service.publishArchive(
            actor,
            {
              operationId: url.searchParams.get("operationId") ?? "",
              slug: url.searchParams.get("slug") ?? "",
              version: url.searchParams.get("version") ?? "",
              id: url.searchParams.get("id") ?? undefined,
              expectedRevision: url.searchParams.has("expectedRevision")
                ? Number(url.searchParams.get("expectedRevision"))
                : undefined,
              sharing,
              reason: url.searchParams.get("reason") ?? undefined,
            },
            archive,
          ),
        );
      } finally {
        await archive.cleanup();
      }
      return true;
    }
    if (
      parts[0] === "skills" &&
      parts[1] === "by-id" &&
      parts[2] &&
      parts[3] === "icon" &&
      parts.length === 4 &&
      (method === "PUT" || method === "DELETE")
    ) {
      const expectedRevision = Number(url.searchParams.get("expectedRevision"));
      const icon = method === "DELETE" ? null : await readIconBody(req);
      sendBrowserJson(
        res,
        200,
        await options.service.updateIcon(
          actor.user,
          parts[2],
          expectedRevision,
          icon,
          typeof req.headers["x-skill-hub-reason"] === "string"
            ? decodeSegment(req.headers["x-skill-hub-reason"])
            : undefined,
        ),
      );
      return true;
    }
    const body = await json();
    if (method === "POST" && route === "publish") {
      const source = optionalString(body, "source");
      if (source !== undefined && source !== "platform_server" && source !== "assigned_vm") {
        throw new SkillHubServiceError("Invalid publication source", 400);
      }
      sendBrowserJson(
        res,
        200,
        await options.service.publish(actor, {
          operationId: stringField(body, "operationId"),
          skill: stringField(body, "skill"),
          version: stringField(body, "version"),
          source,
          expectedTargetId: optionalString(body, "expectedTargetId"),
          id: optionalString(body, "id"),
          expectedRevision: optionalInteger(body, "expectedRevision"),
          sharing: sharingValue(body.sharing),
          reason: optionalString(body, "reason"),
        }),
      );
    } else if (method === "POST" && route === "notifications/read") {
      sendBrowserJson(
        res,
        200,
        await options.service.markNotificationsRead(
          actor.user,
          body.ids === undefined ? undefined : stringArray(body.ids, "ids"),
        ),
      );
    } else if (
      method === "POST" &&
      parts[0] === "publications" &&
      parts[1] &&
      parts[2] === "cancel" &&
      parts.length === 3
    ) {
      sendBrowserJson(
        res,
        200,
        await options.service.cancelPublication(
          actor.user,
          parts[1],
          optionalString(body, "reason"),
        ),
      );
    } else if (parts[0] === "skills" && parts[1] === "by-id" && parts[2]) {
      const id = parts[2];
      if (method === "PATCH" && parts.length === 3) {
        if (body.summary !== undefined && typeof body.summary !== "string") {
          throw new SkillHubServiceError("Description must be a string", 400);
        }
        sendBrowserJson(
          res,
          200,
          await options.service.updateMetadata(actor.user, id, {
            expectedRevision: integerField(body, "expectedRevision"),
            displayName: optionalString(body, "displayName"),
            summary: body.summary as string | undefined,
            tags: body.tags === undefined ? undefined : stringArray(body.tags, "tags"),
            sharing: sharingValue(body.sharing),
            reason: optionalString(body, "reason"),
          }),
        );
      } else if (method === "POST" && parts[3] === "delete" && parts.length === 4) {
        sendBrowserJson(
          res,
          200,
          await options.service.deletePublishedSkill(
            actor.user,
            id,
            integerField(body, "expectedRevision"),
            optionalString(body, "reason"),
          ),
        );
      } else if (method === "POST" && parts[3] === "restore" && parts.length === 4) {
        sendBrowserJson(
          res,
          200,
          await options.service.restore(
            actor.user,
            id,
            integerField(body, "expectedRevision"),
            optionalString(body, "reason"),
          ),
        );
      } else if (method === "POST" && parts[3] === "transfer" && parts.length === 4) {
        sendBrowserJson(
          res,
          200,
          await options.service.requestTransfer(
            actor.user,
            id,
            integerField(body, "expectedRevision"),
            stringField(body, "userId"),
            optionalString(body, "reason"),
          ),
        );
      } else if (
        method === "POST" &&
        parts[3] === "transfer" &&
        parts[4] === "accept" &&
        parts.length === 5
      ) {
        sendBrowserJson(
          res,
          200,
          await options.service.acceptTransfer(
            actor.user,
            id,
            integerField(body, "expectedRevision"),
            optionalString(body, "reason"),
          ),
        );
      } else if (method === "POST" && parts[3] === "install" && parts.length === 4) {
        const destination = stringField(body, "destination");
        if (destination !== "platform_server" && destination !== "assigned_vm") {
          throw new SkillHubServiceError("Invalid installation destination", 400);
        }
        sendBrowserJson(
          res,
          200,
          await options.service.install(actor, {
            id,
            version: stringField(body, "version"),
            destination,
            expectedTargetId: optionalString(body, "expectedTargetId"),
            acknowledgedReplacement: optionalBoolean(body, "acknowledgedReplacement"),
            currentRevision: optionalString(body, "currentRevision"),
            expectedTargetRevision: optionalInteger(body, "expectedTargetRevision"),
          }),
        );
      } else {
        sendBrowserJson(res, 404, { error: "not found" });
      }
    } else {
      sendBrowserJson(res, 404, { error: "This Skill Hub action is retired; reload the page" });
    }
  } catch (error) {
    sendSkillHubError(res, error);
  }
  return true;
}
