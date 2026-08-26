// Webchat reply media path normalizer for display-safe outbound payloads.
import path from "node:path";
import { MAX_DOCUMENT_BYTES } from "@openclaw/media-core/constants";
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { isAudioFileName, kindFromMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveAllowedManagedMediaPath } from "../../agents/sandbox-paths.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openLocalFileSafely } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { assertLocalMediaAllowed } from "../../media/local-media-access.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { getMediaDir } from "../../media/store.js";
import { resolveSendableOutboundReplyParts } from "../../plugin-sdk/reply-payload.js";

function isDataUrlMedia(mediaUrl: string): boolean {
  return mediaUrl.trim().toLowerCase().startsWith("data:");
}

function shouldPreserveDisplayMediaUrl(payload: ReplyPayload, mediaUrl: string): boolean {
  if (isDataUrlMedia(mediaUrl)) {
    return true;
  }
  if (!isAudioFileName(mediaUrl)) {
    // Webchat-owned HTML stays scoped to the current workspace; outbound
    // channel staging intentionally retains its stricter HTML read policy.
    if (mimeTypeFromFilePath(mediaUrl) === "text/html") {
      return payload.trustedLocalMedia === true;
    }
    return false;
  }
  if (isPassThroughRemoteMediaSource(mediaUrl)) {
    return true;
  }
  // Local audio is preserved only after the producer marks it as already trust-scoped.
  return payload.trustedLocalMedia === true;
}

async function trustOwnedWorkspaceHtmlPayload(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  accountId?: string;
  workspaceDir: string;
  payload: ReplyPayload;
}): Promise<ReplyPayload> {
  const { payload, workspaceDir } = params;
  if (payload.trustedLocalMedia === true || payload.sensitiveMedia === true) {
    return payload;
  }
  const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
  if (
    mediaUrls.length === 0 ||
    !mediaUrls.every(
      (mediaUrl) =>
        mimeTypeFromFilePath(mediaUrl) === "text/html" &&
        !isPassThroughRemoteMediaSource(mediaUrl) &&
        !/^file:/iu.test(mediaUrl),
    )
  ) {
    return payload;
  }
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    accountId: params.accountId,
    workspaceDir,
    mediaSources: mediaUrls,
  });
  if (!mediaAccess.readFile) {
    return payload;
  }
  const ownedPaths: string[] = [];
  for (const mediaUrl of mediaUrls) {
    const filePath = path.isAbsolute(mediaUrl) ? mediaUrl : path.resolve(workspaceDir, mediaUrl);
    let opened: Awaited<ReturnType<typeof openLocalFileSafely>> | undefined;
    try {
      await assertLocalMediaAllowed(filePath, [workspaceDir]);
      opened = await openLocalFileSafely({ filePath });
      await assertLocalMediaAllowed(opened.realPath, [workspaceDir]);
      if (opened.stat.nlink > 1 || opened.stat.size > MAX_DOCUMENT_BYTES) {
        return payload;
      }
      ownedPaths.push(opened.realPath);
    } catch {
      return payload;
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }
  // This browser-only ownership fact never changes outbound host-read policy;
  // authenticated session routing separately scopes delivery to this agent.
  return copyReplyPayloadMetadata(payload, {
    ...payload,
    mediaUrl: ownedPaths[0],
    mediaUrls: ownedPaths,
    trustedLocalMedia: true,
  });
}

async function trustStagedDocumentPayload(
  payload: ReplyPayload,
  originalMediaUrls: readonly string[],
): Promise<ReplyPayload> {
  if (payload.trustedLocalMedia === true || payload.sensitiveMedia === true) {
    return payload;
  }
  const normalizedMediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
  if (normalizedMediaUrls.length === 0) {
    return payload;
  }
  const originalManagedPaths = await Promise.all(
    originalMediaUrls.map(async (mediaUrl) => {
      try {
        return await resolveAllowedManagedMediaPath(mediaUrl);
      } catch {
        return undefined;
      }
    }),
  );
  const outboundRoot = path.join(getMediaDir(), "outbound");
  for (const mediaUrl of normalizedMediaUrls) {
    if (
      kindFromMime(mimeTypeFromFilePath(mediaUrl)) !== "document" ||
      originalMediaUrls.includes(mediaUrl)
    ) {
      return payload;
    }
    const managedPath = await resolveAllowedManagedMediaPath(mediaUrl);
    if (
      !managedPath ||
      !isPathInside(outboundRoot, managedPath) ||
      originalManagedPaths.includes(managedPath)
    ) {
      return payload;
    }
  }
  // Only newly staged document-only payloads inherit the normalizer's verified
  // outbound ownership; remote/data mixtures and raw workspaces never do.
  return copyReplyPayloadMetadata(payload, { ...payload, trustedLocalMedia: true });
}

/** Normalize reply media paths for webchat display without leaking sensitive media. */
export async function normalizeWebchatReplyMediaPathsForDisplay(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  workspaceDir?: string;
  accountId?: string;
  payloads: ReplyPayload[];
}): Promise<ReplyPayload[]> {
  if (params.payloads.length === 0) {
    return params.payloads;
  }
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);
  if (!workspaceDir) {
    return params.payloads;
  }
  const normalizeMediaPaths = createReplyMediaPathNormalizer({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    workspaceDir,
    accountId: params.accountId,
  });
  const normalized: ReplyPayload[] = [];
  for (const inputPayload of params.payloads) {
    const payload = await trustOwnedWorkspaceHtmlPayload({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      accountId: params.accountId,
      workspaceDir,
      payload: inputPayload,
    });
    if (payload.sensitiveMedia === true) {
      // Suppressed media must not be copied into managed outbound storage for display.
      normalized.push(payload);
      continue;
    }
    const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
    if (!mediaUrls.some((mediaUrl) => shouldPreserveDisplayMediaUrl(payload, mediaUrl))) {
      const normalizedPayload = await normalizeMediaPaths(payload);
      normalized.push(await trustStagedDocumentPayload(normalizedPayload, mediaUrls));
      continue;
    }
    if (!mediaUrls.some((mediaUrl) => !shouldPreserveDisplayMediaUrl(payload, mediaUrl))) {
      normalized.push(payload);
      continue;
    }
    const mergedMediaUrls: string[] = [];
    const text = payload.text;
    for (const mediaUrl of mediaUrls) {
      if (shouldPreserveDisplayMediaUrl(payload, mediaUrl)) {
        mergedMediaUrls.push(mediaUrl);
        continue;
      }
      const normalizedPayload = await normalizeMediaPaths({
        ...payload,
        mediaUrl,
        mediaUrls: [mediaUrl],
      });
      const normalizedMediaUrls = resolveSendableOutboundReplyParts(normalizedPayload).mediaUrls;
      if (normalizedMediaUrls.length === 0) {
        continue;
      }
      mergedMediaUrls.push(...normalizedMediaUrls);
    }
    normalized.push(
      await trustStagedDocumentPayload(
        {
          ...payload,
          text,
          mediaUrl: mergedMediaUrls[0],
          mediaUrls: mergedMediaUrls,
        },
        mediaUrls,
      ),
    );
  }
  return normalized;
}
