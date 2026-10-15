import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsFilesDownloadParams,
  validateSessionsFilesDownloadParams,
} from "../../packages/gateway-protocol/src/index.js";
import {
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_BYTES,
} from "../../packages/gateway-protocol/src/schema/terminal-constants.js";
import { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";

// Matches SessionsFilesDownloadResultSchema; JSON can escape each character as six bytes.
export const WORKSPACE_DOWNLOAD_MIME_MAX_LENGTH = 256;

/** Bounds download responses before authorization can resolve or disclose a session target. */
export function preflightWorkspaceDownloadEnvelope(
  id: string,
  params: unknown,
):
  | { status: "ready"; params: SessionsFilesDownloadParams; fileName: string }
  | { status: "reject"; error: ErrorShape }
  | { status: "close" } {
  let message = "Invalid request";
  if (validateSessionsFilesDownloadParams(params)) {
    const fileName = sanitizeUntrustedFileName(path.posix.basename(params.path), "download");
    // Reserve every success field and the largest file; the dispatcher echoes an unbounded ID.
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({
        type: "res",
        id,
        ok: true,
        payload: {
          sessionKey: params.sessionKey,
          file: {
            path: params.path,
            name: fileName,
            size: MAX_TERMINAL_UPLOAD_BYTES,
            mimeType: "\0".repeat(WORKSPACE_DOWNLOAD_MIME_MAX_LENGTH),
            contentBase64: "",
          },
        },
      }),
      "utf8",
    );
    if (envelopeBytes + MAX_TERMINAL_UPLOAD_BASE64_LENGTH <= MAX_PAYLOAD_BYTES) {
      return { status: "ready", params, fileName };
    }
    message = "Shorten request";
  }
  const error = errorShape(ErrorCodes.INVALID_REQUEST, message);
  // Invalid/missing params can leave less room than even this compact echoed error needs.
  const errorBytes = Buffer.byteLength(
    JSON.stringify({ type: "res", id, ok: false, error }),
    "utf8",
  );
  return errorBytes <= MAX_PAYLOAD_BYTES ? { status: "reject", error } : { status: "close" };
}
