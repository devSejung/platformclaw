import { ControlPlaneStateError } from "./contracts.js";
import type { SpaceService } from "./space-service.js";

export function parseSpaceReadRequest(
  body: Record<string, unknown>,
  agentId: string,
): Parameters<SpaceService["agentRead"]>[0] {
  const allowed = new Set([
    "agentId",
    "operation",
    "query",
    "authorName",
    "authorId",
    "spaceId",
    "pageId",
    "conversationId",
    "sessionKey",
    "runId",
    "messageId",
    "bodyOffset",
    "pageRevision",
    "limit",
    "cursor",
    "bodyLimitBytes",
    "messageOffset",
    "nativeTool",
    "targetSessionKey",
    "targetLabel",
    "targetAgentId",
    "nativeAction",
    "broad",
  ]);
  if (
    ((body.authorName !== undefined || body.authorId !== undefined) &&
      (body.operation !== "search" ||
        (body.authorName !== undefined && body.authorId !== undefined))) ||
    (body.authorName !== undefined &&
      (typeof body.authorName !== "string" ||
        !body.authorName.trim() ||
        body.authorName.length > 240)) ||
    (body.authorId !== undefined &&
      (typeof body.authorId !== "string" || !body.authorId.trim() || body.authorId.length > 128)) ||
    (body.limit !== undefined &&
      (!Number.isSafeInteger(body.limit) ||
        (body.limit as number) < 1 ||
        (body.limit as number) > (body.operation === "get" ? 8 : 20))) ||
    (body.cursor !== undefined &&
      (body.operation !== "search" ||
        typeof body.cursor !== "string" ||
        body.cursor.length > 32 ||
        !/^(0|[1-9][0-9]*)$/u.test(body.cursor) ||
        Number(body.cursor) >= 20)) ||
    (body.bodyLimitBytes !== undefined &&
      (!Number.isSafeInteger(body.bodyLimitBytes) ||
        (body.bodyLimitBytes as number) < 64 ||
        (body.bodyLimitBytes as number) > 8000)) ||
    (body.messageOffset !== undefined &&
      (!Number.isSafeInteger(body.messageOffset) ||
        (body.messageOffset as number) < 0 ||
        (body.messageOffset as number) > 16000 ||
        typeof body.messageId !== "string" ||
        !body.messageId)) ||
    (body.bodyOffset !== undefined &&
      (!Number.isSafeInteger(body.bodyOffset) ||
        (body.bodyOffset as number) < 0 ||
        (body.bodyOffset as number) > 32000)) ||
    (body.pageRevision !== undefined &&
      (!Number.isSafeInteger(body.pageRevision) || (body.pageRevision as number) < 1)) ||
    (body.operation === "native" &&
      (typeof body.nativeTool !== "string" || typeof body.broad !== "boolean")) ||
    (body.broad !== undefined && typeof body.broad !== "boolean") ||
    !["search", "get", "context", "native"].includes(String(body.operation)) ||
    Object.keys(body).some((key) => !allowed.has(key)) ||
    [
      "query",
      "spaceId",
      "pageId",
      "conversationId",
      "sessionKey",
      "runId",
      "messageId",
      "nativeTool",
      "targetSessionKey",
      "targetLabel",
      "targetAgentId",
      "nativeAction",
    ].some(
      (key) =>
        body[key] !== undefined &&
        (typeof body[key] !== "string" || (body[key] as string).length > 1000),
    )
  ) {
    throw new ControlPlaneStateError("Invalid Space read");
  }
  return {
    agentId,
    operation: body.operation as string,
    ...(body.query === undefined ? {} : { query: body.query as string }),
    ...(body.authorName === undefined ? {} : { authorName: body.authorName as string }),
    ...(body.authorId === undefined ? {} : { authorId: body.authorId as string }),
    ...(body.spaceId === undefined ? {} : { spaceId: body.spaceId as string }),
    ...(body.pageId === undefined ? {} : { pageId: body.pageId as string }),
    ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId as string }),
    ...(body.sessionKey === undefined ? {} : { sessionKey: body.sessionKey as string }),
    ...(body.runId === undefined ? {} : { runId: body.runId as string }),
    ...(body.messageId === undefined ? {} : { messageId: body.messageId as string }),
    ...(body.bodyOffset === undefined ? {} : { bodyOffset: body.bodyOffset as number }),
    ...(body.pageRevision === undefined ? {} : { pageRevision: body.pageRevision as number }),
    ...(body.limit === undefined ? {} : { limit: body.limit as number }),
    ...(body.cursor === undefined ? {} : { cursor: body.cursor as string }),
    ...(body.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: body.bodyLimitBytes as number }),
    ...(body.messageOffset === undefined ? {} : { messageOffset: body.messageOffset as number }),
    ...(body.nativeTool === undefined ? {} : { nativeTool: body.nativeTool as string }),
    ...(body.targetSessionKey === undefined
      ? {}
      : { targetSessionKey: body.targetSessionKey as string }),
    ...(body.targetLabel === undefined ? {} : { targetLabel: body.targetLabel as string }),
    ...(body.targetAgentId === undefined ? {} : { targetAgentId: body.targetAgentId as string }),
    ...(body.nativeAction === undefined ? {} : { nativeAction: body.nativeAction as string }),
    ...(body.broad === undefined ? {} : { broad: body.broad as boolean }),
  };
}
