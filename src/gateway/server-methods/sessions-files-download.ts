import { detectMime } from "@openclaw/media-core/mime";
import {
  ErrorCodes,
  errorShape,
  isCloudWorkerPlacementState,
  type SessionsFilesDownloadParams,
  type SessionsFilesDownloadResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { MAX_TERMINAL_UPLOAD_BYTES } from "../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import {
  preflightWorkspaceDownloadEnvelope,
  WORKSPACE_DOWNLOAD_MIME_MAX_LENGTH,
} from "../workspace-download-envelope.js";
import { loadSessionFileRoot } from "./sessions-file-root.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { readWorkspaceFile } from "./workspace-fs.js";

// One admitted file keeps raw bytes and base64 under the Gateway's outbound-buffer budget.
let downloadActive = false;

async function downloadError(
  respond: RespondFn,
  type: string,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const error = errorShape(ErrorCodes.INVALID_REQUEST, message, { details: { type, ...details } });
  if (respond.withCompletion) {
    await respond.withCompletion(false, undefined, error);
  } else {
    respond(false, undefined, error);
  }
}

function canonicalDownloadPath(filePath: string): boolean {
  return (
    !filePath.includes("\0") &&
    !filePath.includes("\\") &&
    !/^[a-z]:/iu.test(filePath) &&
    filePath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function loadDownloadTarget(params: SessionsFilesDownloadParams, context: GatewayRequestContext) {
  const loaded = loadSessionFileRoot(params);
  if (
    !loaded.root ||
    !loaded.entry?.sessionId ||
    (params.agentId !== undefined && loaded.agentId !== params.agentId) ||
    loaded.entry.execNode ||
    loaded.entry.execHost === "node"
  ) {
    return undefined;
  }
  const placement = context.workerSessionPlacementService
    ?.getMany([loaded.entry.sessionId])
    .get(loaded.entry.sessionId);
  if (isCloudWorkerPlacementState(placement?.state)) {
    return undefined;
  }
  return {
    root: loaded.root,
    sessionId: loaded.entry.sessionId,
    sessionKey: loaded.canonicalKey,
    agentId: loaded.agentId,
    placementGeneration: placement?.generation,
  };
}

export const sessionsFilesDownloadHandlers: GatewayRequestHandlers = {
  "sessions.files.download": async ({
    req,
    params: rawParams,
    respond,
    context,
    sessionMutationAuthorization,
  }) => {
    const preflight = preflightWorkspaceDownloadEnvelope(req.id, rawParams);
    if (preflight.status === "close") {
      // Real transports close at dispatch; manual adapters receive a terminal failure instead.
      throw new Error("Workspace download request exceeds the response envelope budget");
    }
    if (preflight.status === "reject") {
      if (respond.withCompletion) {
        await respond.withCompletion(false, undefined, preflight.error);
      } else {
        respond(false, undefined, preflight.error);
      }
      return;
    }
    const { params, fileName } = preflight;
    if (!canonicalDownloadPath(params.path)) {
      await downloadError(respond, "session_file_unsafe", "Select a file inside the workspace");
      return;
    }
    // Large responses require an explicit transport completion boundary. Legacy in-process
    // responders must opt in only when they synchronously consume or finish sending the payload.
    if (!respond.withCompletion) {
      await downloadError(
        respond,
        "session_file_download_unavailable",
        "This connection cannot confirm download completion; reconnect and retry",
      );
      return;
    }
    if (downloadActive) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "A workspace download is still in progress; retry after it finishes",
          {
            retryable: true,
            details: { type: "session_file_download_busy" },
          },
        ),
      );
      return;
    }
    downloadActive = true;
    try {
      const target = loadDownloadTarget(params, context);
      if (!target) {
        await downloadError(
          respond,
          "session_file_download_unavailable",
          "No local workspace is available for this session; reload and retry",
        );
        return;
      }
      // Share the upload byte cap while keeping the 256 KiB preview reader unchanged.
      const read = await readWorkspaceFile(target.root, params.path, {
        maxBytes: MAX_TERMINAL_UPLOAD_BYTES,
      });
      if (read === "too-large") {
        await downloadError(
          respond,
          "session_file_too_large",
          "Workspace downloads are limited to 16 MiB per file",
          {
            path: params.path,
            maxDownloadBytes: MAX_TERMINAL_UPLOAD_BYTES,
          },
        );
        return;
      }
      if (!read || read.canonicalPath !== params.path || read.buffer.length !== read.stat.size) {
        await downloadError(
          respond,
          "session_file_not_found",
          "Workspace file unavailable; refresh and retry",
        );
        return;
      }
      const detectedMime = await detectMime({ buffer: read.buffer, filePath: read.canonicalPath });
      const mimeType =
        detectedMime && detectedMime.length <= WORKSPACE_DOWNLOAD_MIME_MAX_LENGTH
          ? detectedMime
          : "application/octet-stream";
      sessionMutationAuthorization?.assertCurrent();
      // Reading and MIME detection yield; never return a stale local copy after session reassignment.
      const current = loadDownloadTarget(params, context);
      if (
        !current ||
        current.root !== target.root ||
        current.sessionId !== target.sessionId ||
        current.sessionKey !== target.sessionKey ||
        current.agentId !== target.agentId ||
        current.placementGeneration !== target.placementGeneration
      ) {
        await downloadError(
          respond,
          "session_file_download_unavailable",
          "The session workspace changed; refresh and retry",
        );
        return;
      }
      await respond.withCompletion(true, {
        sessionKey: params.sessionKey,
        file: {
          path: read.canonicalPath,
          name: fileName,
          size: read.buffer.length,
          mimeType,
          contentBase64: read.buffer.toString("base64"),
        },
      } satisfies SessionsFilesDownloadResult);
    } finally {
      downloadActive = false;
    }
  },
};
