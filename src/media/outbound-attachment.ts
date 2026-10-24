// Outbound attachment helpers prepare media attachments for channel delivery.
import { rm } from "node:fs/promises";
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { resolveAllowedManagedMediaPath } from "../agents/sandbox-paths.js";
import type { SandboxOutboundFileAccess } from "../agents/sandbox/fs-bridge.types.js";
import { hasEncodedFileUrlSeparator } from "../infra/local-file-access.js";
import { createBoundedOutboundMediaReadFile } from "./bounded-read-file.js";
import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "./load-options.js";
import { saveMediaBuffer } from "./store.js";
import { loadWebMedia, markTrustedGeneratedHtmlPath } from "./web-media.js";

/** Copies a file from the prepared execution runtime, never the Gateway's matching path. */
export async function resolveOutboundAttachmentFromRuntime(
  mediaUrl: string,
  maxBytes: number,
  options: { fileAccess: SandboxOutboundFileAccess; signal?: AbortSignal },
): Promise<{ path: string; contentType?: string }> {
  options.signal?.throwIfAborted();
  if (isPassThroughRemoteMediaSource(mediaUrl)) {
    return { path: mediaUrl };
  }
  const managedPath = await resolveAllowedManagedMediaPath(mediaUrl);
  options.signal?.throwIfAborted();
  if (managedPath) {
    return { path: managedPath };
  }
  let runtimePath = mediaUrl;
  if (/^file:/iu.test(mediaUrl)) {
    const url = new URL(mediaUrl);
    if (
      (url.hostname && url.hostname !== "localhost") ||
      url.search ||
      url.hash ||
      hasEncodedFileUrlSeparator(url.pathname)
    ) {
      throw new Error("Runtime attachment requires a local file URL without encoded separators.");
    }
    runtimePath = decodeURIComponent(url.pathname);
  }
  // Loaders may expand ~ against the host before invoking a custom reader.
  // Keep runtime names opaque to them; only the pinned access resolves paths.
  const readFile = createBoundedOutboundMediaReadFile(async (_filePath, bounds) =>
    options.fileAccess.readFile({
      filePath: runtimePath,
      maxBytes: Math.min(maxBytes, bounds?.maxBytes ?? maxBytes),
      signal: options.signal,
    }),
  );
  const media = await loadWebMedia(
    runtimePath.startsWith("~/") ? runtimePath.slice(2) : runtimePath,
    {
      maxBytes,
      sandboxValidated: true,
      readFile,
      optimizeImages: false,
    },
  );
  options.signal?.throwIfAborted();
  await options.fileAccess.assertCurrentAuthority?.();
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType,
    "outbound",
    maxBytes,
    media.fileName,
  );
  try {
    options.signal?.throwIfAborted();
    await options.fileAccess.assertCurrentAuthority?.();
    options.signal?.throwIfAborted();
    return { path: saved.path, contentType: saved.contentType };
  } catch (error) {
    await rm(saved.path, { force: true });
    throw error;
  }
}

/** Loads a remote/local media URL and stages it into the outbound media store. */
export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: {
    mediaAccess?: OutboundMediaAccess;
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  },
): Promise<{ path: string; contentType?: string }> {
  const media = await loadWebMedia(
    mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes,
      mediaAccess: options?.mediaAccess,
      mediaLocalRoots: options?.localRoots,
      mediaReadFile: options?.readFile,
    }),
  );
  // Preserve source file names so outbound attachments keep useful names after UUID staging.
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
    media.fileName,
  );
  if (media.trustedGeneratedHtmlSource) {
    try {
      await markTrustedGeneratedHtmlPath(saved.path, media.buffer);
    } catch (error) {
      await rm(saved.path, { force: true }).catch(() => {});
      throw error;
    }
  }
  return { path: saved.path, contentType: saved.contentType };
}

/** Stages an in-memory attachment buffer into the outbound media store. */
export async function resolveOutboundAttachmentFromBuffer(
  buffer: Buffer,
  maxBytes: number,
  options?: {
    contentType?: string;
    filename?: string;
  },
): Promise<{ path: string; contentType?: string }> {
  const saved = await saveMediaBuffer(
    buffer,
    options?.contentType,
    "outbound",
    maxBytes,
    options?.filename,
  );
  return { path: saved.path, contentType: saved.contentType };
}
