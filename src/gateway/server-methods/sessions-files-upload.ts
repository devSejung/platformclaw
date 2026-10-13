import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  isCloudWorkerPlacementState,
  validateSessionsFilesUploadParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  isCanonicalTerminalUploadBase64,
  MAX_TERMINAL_UPLOAD_BYTES,
  terminalUploadDecodedSize,
} from "../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import { root as fsSafeRoot, FsSafeError, type Root } from "../../infra/fs-safe.js";
import { loadSessionFileRoot } from "./sessions-file-root.js";
import {
  MAX_SESSION_UPLOAD_NAME_BYTES,
  verifySessionUploadFolder,
  verifySessionUploadRoot,
} from "./sessions-files-upload-target.js";
import {
  acquireSessionFileUploadLease,
  SessionUploadWorkerError,
} from "./sessions-files-upload-worker.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function safeUploadSegment(value: string): boolean {
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  return (
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    Buffer.byteLength(value, "utf8") <= 255 &&
    Buffer.from(value, "utf8").toString("utf8") === value &&
    !hasControlCharacter &&
    !/[<>:"/\\|?*]/u.test(value) &&
    !/[. ]$/u.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(value)
  );
}

function safeUploadFolder(value: string): boolean {
  return value === "" || value.split("/").every(safeUploadSegment);
}

async function openUploadWorkspace(rootDir: string, folder: string): Promise<Root | undefined> {
  try {
    const workspace = await fsSafeRoot(rootDir, { symlinks: "reject", hardlinks: "reject" });
    await verifySessionUploadFolder(workspace, folder);
    return workspace;
  } catch {
    return undefined;
  }
}

function isRemoteWorkspace(
  loaded: ReturnType<typeof loadSessionFileRoot>,
  context: GatewayRequestContext,
): boolean {
  const placement = loaded.entry?.sessionId
    ? context.workerSessionPlacementService
        ?.getMany([loaded.entry.sessionId])
        .get(loaded.entry.sessionId)
    : undefined;
  return Boolean(loaded.entry?.execNode) || isCloudWorkerPlacementState(placement?.state);
}

export async function isSessionFileUploadAllowed(
  params: { sessionKey: string; agentId?: string; path?: string },
  context: GatewayRequestContext,
): Promise<boolean> {
  const loaded = loadSessionFileRoot(params);
  const folder = params.path ?? "";
  if (!loaded.root || isRemoteWorkspace(loaded, context) || !safeUploadFolder(folder)) {
    return false;
  }
  return (await openUploadWorkspace(loaded.root, folder)) !== undefined;
}

function uploadError(
  respond: RespondFn,
  type: string,
  message: string,
  outcome: "not-written" | "unknown" = "not-written",
): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, message, {
      details: {
        type,
        outcome,
        // Duplicate/helper-unavailable can be known no-write after Worker GO;
        // do not mislabel that transport phase as rejected before dispatch.
        ...(outcome === "unknown" ? { requestDisposition: "outcome-unknown" } : {}),
      },
      retryable: false,
    }),
  );
}

export const sessionsFilesUploadHandlers: GatewayRequestHandlers = {
  "sessions.files.upload": async ({
    params,
    context,
    respond,
    sessionMutationAuthorization,
    signal,
  }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsFilesUploadParams,
        "sessions.files.upload",
        respond,
      )
    ) {
      return;
    }
    if (!safeUploadSegment(params.name) || !safeUploadFolder(params.path)) {
      uploadError(
        respond,
        "session_file_unsafe",
        "Select a file name and folder inside the workspace",
      );
      return;
    }
    if (Buffer.byteLength(params.name, "utf8") > MAX_SESSION_UPLOAD_NAME_BYTES) {
      uploadError(
        respond,
        "session_file_name_too_long",
        "Upload file names are limited to 206 UTF-8 bytes; shorten the name and retry",
      );
      return;
    }
    // Use the terminal's bounded file encoding contract without staging into its expiring temp root.
    if (terminalUploadDecodedSize(params.contentBase64) > MAX_TERMINAL_UPLOAD_BYTES) {
      uploadError(
        respond,
        "session_file_too_large",
        "Workspace uploads are limited to 16 MiB per file",
      );
      return;
    }
    if (!isCanonicalTerminalUploadBase64(params.contentBase64)) {
      uploadError(
        respond,
        "session_file_invalid_encoding",
        "Workspace upload contains invalid base64 content",
      );
      return;
    }
    const loaded = loadSessionFileRoot(params);
    if (!loaded.root) {
      uploadError(
        respond,
        "session_file_not_found",
        "No workspace is available for this session; reload and retry",
      );
      return;
    }
    if (isRemoteWorkspace(loaded, context)) {
      uploadError(
        respond,
        "session_file_upload_unavailable",
        "Uploads are available only for local workspaces",
      );
      return;
    }
    const uploadTarget = {
      sessionId: loaded.entry?.sessionId,
      sessionKey: loaded.canonicalKey,
      agentId: loaded.agentId,
      root: loaded.root,
    };
    // Admission precedes decoding and every async path lookup. There is no
    // waiting queue; a native operation that cannot finish keeps its slot.
    const lease = acquireSessionFileUploadLease();
    if (!lease) {
      uploadError(
        respond,
        "session_file_upload_busy",
        "Two uploads are already in progress; retry after they finish",
      );
      return;
    }
    const relativePath = params.path ? `${params.path}/${params.name}` : params.name;
    try {
      const workspaceRoot = await openUploadWorkspace(loaded.root, params.path);
      if (!workspaceRoot) {
        uploadError(
          respond,
          "session_file_unsafe",
          "The upload folder is unavailable; refresh and retry",
        );
        return;
      }
      const rootIdentity = await workspaceRoot.stat(".");
      const destinationPath = path.resolve(workspaceRoot.rootReal, ...params.path.split("/"));
      const destinationRoot = params.path
        ? await fsSafeRoot(destinationPath, { symlinks: "reject", hardlinks: "reject" })
        : workspaceRoot;
      if (destinationRoot.rootReal !== destinationPath) {
        throw new FsSafeError("path-mismatch", "Upload folder is an alias");
      }
      const destinationIdentity = await destinationRoot.stat(".");
      await verifySessionUploadRoot(workspaceRoot, {
        rootReal: workspaceRoot.rootReal,
        dev: rootIdentity.dev,
        ino: rootIdentity.ino,
      });
      const bytes = Buffer.from(params.contentBase64, "base64");
      if (bytes.length > MAX_TERMINAL_UPLOAD_BYTES) {
        uploadError(
          respond,
          "session_file_too_large",
          "Workspace uploads are limited to 16 MiB per file",
        );
        return;
      }
      await lease.run({
        target: {
          rootReal: workspaceRoot.rootReal,
          dev: rootIdentity.dev,
          ino: rootIdentity.ino,
          destination: {
            rootReal: destinationRoot.rootReal,
            dev: destinationIdentity.dev,
            ino: destinationIdentity.ino,
          },
          relativePath,
          size: bytes.length,
        },
        bytes,
        signal,
        assertCurrent: () => {
          // The worker has pinned the original root and is ready. Recheck the
          // caller and session before transferring any bytes or authorizing a write.
          sessionMutationAuthorization?.assertCurrent();
          const current = loadSessionFileRoot(params);
          // Admin service calls have no participation guard; their local
          // session/root and execution target still must match admission.
          if (
            current.entry?.sessionId !== uploadTarget.sessionId ||
            current.canonicalKey !== uploadTarget.sessionKey ||
            current.agentId !== uploadTarget.agentId ||
            current.root !== uploadTarget.root ||
            isRemoteWorkspace(current, context)
          ) {
            throw new SessionUploadWorkerError("path-mismatch", "not-written");
          }
        },
      });
      respond(true, { sessionKey: params.sessionKey, path: relativePath, size: bytes.length });
    } catch (error) {
      if (error instanceof SessionUploadWorkerError) {
        if (error.outcome === "unknown") {
          uploadError(
            respond,
            "session_file_upload_outcome_unknown",
            "The upload result could not be confirmed; refresh the workspace before retrying",
            "unknown",
          );
        } else if (error.code === "already-exists") {
          uploadError(
            respond,
            "session_file_exists",
            "A file with this name already exists; rename the file and retry",
          );
        } else if (error.code === "helper-unavailable" || error.code === "path-mismatch") {
          uploadError(
            respond,
            "session_file_upload_unavailable",
            "The session workspace or safe upload helper is unavailable; reload and retry",
          );
        } else {
          uploadError(
            respond,
            "session_file_unsafe",
            "The file could not be uploaded safely; refresh the workspace and retry",
          );
        }
        return;
      }
      if (error instanceof FsSafeError) {
        uploadError(
          respond,
          error.code === "already-exists" ? "session_file_exists" : "session_file_unsafe",
          error.code === "already-exists"
            ? "A file with this name already exists; rename the file and retry"
            : "The file could not be uploaded safely; refresh the workspace and retry",
        );
        return;
      }
      if (
        error instanceof Error &&
        "code" in error &&
        ["EACCES", "EPERM", "ENOSPC"].includes(String(error.code))
      ) {
        uploadError(
          respond,
          "session_file_upload_failed",
          "The file could not be saved; check workspace access and free space, then retry",
        );
        return;
      }
      throw error;
    } finally {
      // Once a Worker exists, only its exit event can release this lease.
      lease.release();
    }
  },
};
