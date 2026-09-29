import { createHash } from "node:crypto";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { walkMemoryWikiDirectory } from "./bounded-walk.js";
import { isGeneratedMemoryWikiPage } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { MemoryWikiEditConflictError, MemoryWikiEditValidationError } from "./document-edit.js";
import { toWikiPageSummary } from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { initializeMemoryWikiVault } from "./vault.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 999;
const MAX_CHUNK_BYTES = 196_608;
const HASH = /^[a-f0-9]{64}$/u;
const DOCUMENT_DIRS = new Set(["entities", "concepts", "syntheses", "sources", "reports"]);

function requirePersonal(config: ResolvedMemoryWikiConfig) {
  if (config.vault.scope !== "agent" || !config.agentId) {
    throw new MemoryWikiEditValidationError("Archive operations require a Personal Wiki.");
  }
}

function artifactPath(value: string): "document" | "attachment" {
  if (
    value.length > 512 ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    value
      .split("")
      .some((character) => character.charCodeAt(0) < 32 || character === "\\" || character === ":")
  ) {
    throw new MemoryWikiEditValidationError("Use a canonical Wiki artifact path.");
  }
  if (value.startsWith("_attachments/")) {
    return "attachment";
  }
  if (value.endsWith(".md") && (DOCUMENT_DIRS.has(value.split("/")[0]!) || value === "inbox.md")) {
    return "document";
  }
  throw new MemoryWikiEditValidationError(
    "Only Wiki documents and attachments can be transferred.",
  );
}

function revision(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function generated(path: string, bytes: Buffer) {
  if (!isGeneratedMemoryWikiPage(path)) {
    return false;
  }
  // An authored document at a reserved report name is still source material.
  return (
    path.endsWith("/index.md") ||
    path === "index.md" ||
    bytes.includes(Buffer.from("<!-- openclaw:wiki:"))
  );
}

async function readArtifact(config: ResolvedMemoryWikiConfig, path: string) {
  const kind = artifactPath(path);
  const root = await fsRoot(config.vault.path);
  const bytes = await root.readBytes(path, {
    maxBytes: kind === "document" ? 1024 * 1024 : MAX_FILE_BYTES,
    hardlinks: "reject",
    symlinks: "reject",
  });
  if (kind === "document" && generated(path, bytes)) {
    throw new MemoryWikiEditValidationError("Generated Wiki indexes are rebuilt, not exported.");
  }
  return { kind, bytes };
}

/** Explicit export reads source files, never the compiler snapshot or external source paths. */
export async function listMemoryWikiArchive(
  config: ResolvedMemoryWikiConfig,
  kindFilter?: "attachment",
) {
  requirePersonal(config);
  return withMemoryWikiVaultMutation(config.vault.path, async () => {
    const entries = await walkMemoryWikiDirectory(config.vault.path, "", {
      entryFilter: (entry) => {
        const first = entry.relativePath.replaceAll("\\", "/").split("/")[0]!;
        return entry.kind === "directory" &&
          first !== "_attachments" &&
          (kindFilter === "attachment" || !DOCUMENT_DIRS.has(first))
          ? "skip-subtree"
          : "include";
      },
    });
    const files: Array<{
      path: string;
      kind: "document" | "attachment";
      size: number;
      revision: string;
      title?: string;
      mediaType?: string;
    }> = [];
    let totalBytes = 0;
    let truncated = false;
    const root = await fsRoot(config.vault.path);
    for (const entry of entries) {
      if (entry.kind !== "file") {
        continue;
      }
      const path = entry.relativePath.replaceAll("\\", "/");
      if (
        !path.startsWith("_attachments/") &&
        !(path.endsWith(".md") && (DOCUMENT_DIRS.has(path.split("/")[0]!) || path === "inbox.md"))
      ) {
        continue;
      }
      const kind = artifactPath(path);
      if (kindFilter && kind !== kindFilter) {
        continue;
      }
      if (kindFilter && files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      if (kindFilter) {
        const stat = await root.stat(path);
        if (totalBytes + stat.size > MAX_EXPANDED_BYTES) {
          truncated = true;
          break;
        }
      }
      const bytes = await root.readBytes(path, {
        maxBytes: kind === "document" ? 1024 * 1024 : MAX_FILE_BYTES,
        hardlinks: "reject",
        symlinks: "reject",
      });
      if (kind === "document" && generated(path, bytes)) {
        continue;
      }
      totalBytes += bytes.length;
      if (!kindFilter && (files.length >= MAX_FILES || totalBytes > MAX_EXPANDED_BYTES)) {
        throw new MemoryWikiEditValidationError(
          "Wiki export supports at most 999 files and 64 MiB of source data.",
        );
      }
      let title: string | undefined;
      if (kind === "document") {
        try {
          title = toWikiPageSummary({
            absolutePath: path,
            relativePath: path,
            raw: bytes.toString("utf8"),
          })?.title;
        } catch {
          /* A broken index must not prevent exporting original source. */
        }
      }
      files.push({
        path,
        kind,
        size: bytes.length,
        revision: revision(bytes),
        ...(title ? { title } : {}),
        ...(kind === "attachment" ? { mediaType: "application/octet-stream" } : {}),
      });
    }
    return {
      entries: files.toSorted((a, b) => a.path.localeCompare(b.path)),
      totalBytes,
      truncated,
    };
  });
}

export async function readMemoryWikiArchive(params: {
  config: ResolvedMemoryWikiConfig;
  path: string;
  expectedRevision: string;
  offset?: number;
  length?: number;
}) {
  requirePersonal(params.config);
  const offset = params.offset ?? 0;
  const length = params.length ?? MAX_CHUNK_BYTES;
  if (
    !HASH.test(params.expectedRevision) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAX_CHUNK_BYTES
  ) {
    throw new MemoryWikiEditValidationError(
      "Reload the Wiki archive manifest and request a bounded file chunk.",
    );
  }
  const { bytes } = await readArtifact(params.config, params.path);
  if (revision(bytes) !== params.expectedRevision) {
    throw new MemoryWikiEditConflictError(
      "Wiki source changed during download; restart the export.",
    );
  }
  if (offset > bytes.length) {
    throw new MemoryWikiEditValidationError("File offset exceeds the source size.");
  }
  const end = Math.min(bytes.length, offset + length);
  return {
    path: params.path,
    revision: params.expectedRevision,
    contentBase64: bytes.subarray(offset, end).toString("base64"),
    totalBytes: bytes.length,
    nextOffset: end < bytes.length ? end : null,
  };
}

export async function putMemoryWikiAttachment(params: {
  config: ResolvedMemoryWikiConfig;
  path: string;
  contentBase64: string;
  expectedRevision?: string;
}) {
  requirePersonal(params.config);
  const path = `_attachments/${params.path}`;
  artifactPath(path);
  if (
    params.contentBase64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(params.contentBase64)
  ) {
    throw new MemoryWikiEditValidationError("Attachment must be valid base64 and at most 8 MiB.");
  }
  const bytes = Buffer.from(params.contentBase64, "base64");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new MemoryWikiEditValidationError("Attachment exceeds 8 MiB.");
  }
  return withMemoryWikiVaultMutation(params.config.vault.path, async () => {
    await initializeMemoryWikiVault(params.config);
    const root = await fsRoot(params.config.vault.path);
    if (params.expectedRevision === undefined) {
      await root.create(path, bytes);
    } else {
      const prior = await readArtifact(params.config, path);
      if (
        !HASH.test(params.expectedRevision) ||
        revision(prior.bytes) !== params.expectedRevision
      ) {
        throw new MemoryWikiEditConflictError("Attachment changed; reload before replacing it.");
      }
      await root.write(path, bytes);
    }
    return {
      path,
      size: bytes.length,
      revision: revision(bytes),
      mediaType: "application/octet-stream",
    };
  });
}

export async function deleteMemoryWikiAttachment(params: {
  config: ResolvedMemoryWikiConfig;
  path: string;
  expectedRevision: string;
}) {
  requirePersonal(params.config);
  if (artifactPath(params.path) !== "attachment") {
    throw new MemoryWikiEditValidationError("Only an attachment can be deleted here.");
  }
  return withMemoryWikiVaultMutation(params.config.vault.path, async () => {
    const prior = await readArtifact(params.config, params.path);
    if (!HASH.test(params.expectedRevision) || revision(prior.bytes) !== params.expectedRevision) {
      throw new MemoryWikiEditConflictError("Attachment changed; reload before deleting it.");
    }
    await (await fsRoot(params.config.vault.path)).remove(params.path);
    return { deleted: true, path: params.path };
  });
}
