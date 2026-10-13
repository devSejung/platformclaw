import { FsSafeError, type FsSafeErrorCode } from "@openclaw/fs-safe/errors";
import type { Root } from "@openclaw/fs-safe/root";

// fs-safe 0.5.3 creates a private temporary basename with 49 extra UTF-8
// bytes. Leave that room beneath Linux's 255-byte component limit.
export const MAX_SESSION_UPLOAD_NAME_BYTES = 206;

export type SessionUploadRootIdentity = { rootReal: string; dev: number; ino: number };

export type SessionUploadWorkerTarget = {
  rootReal: string;
  dev: number;
  ino: number;
  destination: SessionUploadRootIdentity;
  relativePath: string;
  size: number;
};

export type SessionUploadOutcome = "not-written" | "unknown";
export type SessionUploadWorkerMessage =
  | { type: "ready" }
  | { type: "written" }
  | { type: "failed"; code: FsSafeErrorCode; outcome: SessionUploadOutcome };
export type SessionUploadWorkerRequest = { type: "cancel" } | { type: "write"; bytes: Uint8Array };

export async function verifySessionUploadRoot(
  workspace: Pick<Root, "rootReal" | "stat">,
  expected: SessionUploadRootIdentity,
): Promise<void> {
  const current = await workspace.stat(".");
  if (
    workspace.rootReal !== expected.rootReal ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new FsSafeError("path-mismatch", "Workspace root changed before upload");
  }
}

export async function verifySessionUploadFolder(
  workspace: Pick<Root, "list">,
  folder: string,
): Promise<void> {
  let parent = ".";
  // stat canonicalizes aliases. Inspect lexical entries so an in-root symlink
  // cannot silently redirect the folder selected by the browser.
  for (const name of folder ? folder.split("/") : []) {
    const entry = (await workspace.list(parent, { withFileTypes: true })).find(
      (candidate) => candidate.name === name,
    );
    if (!entry || !entry.isDirectory || entry.isSymbolicLink) {
      throw new FsSafeError("invalid-path", "Upload folder is unavailable");
    }
    parent = parent === "." ? name : `${parent}/${name}`;
  }
}
