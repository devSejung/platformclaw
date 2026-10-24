// Resolves media paths from reply payloads into runtime attachment metadata.
import path from "node:path";
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolvePathFromInput, toRelativeWorkspacePath } from "../../agents/path-policy.js";
import {
  assertMediaNotDataUrl,
  resolveAllowedManagedMediaPath,
  resolveSandboxedMediaSource,
} from "../../agents/sandbox-paths.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import type { SandboxContext } from "../../agents/sandbox/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { withAgentMediaContext } from "../../media/agent-media-context.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import {
  resolveOutboundAttachmentFromRuntime,
  resolveOutboundAttachmentFromUrl,
} from "../../media/outbound-attachment.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import {
  appendReplyMediaFailureWarning,
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

const FILE_URL_RE = /^file:\/\//i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT_RE = /\.\w{1,10}$/;

function isLikelyLocalMediaSource(media: string): boolean {
  return (
    FILE_URL_RE.test(media) ||
    media.startsWith("/") ||
    media.startsWith("./") ||
    media.startsWith("../") ||
    media.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(media) ||
    media.startsWith("\\\\") ||
    (!SCHEME_RE.test(media) &&
      (media.includes("/") || media.includes("\\") || HAS_FILE_EXT_RE.test(media)))
  );
}

function getPayloadMediaList(payload: ReplyPayload): string[] {
  return resolveSendableOutboundReplyParts(payload).mediaUrls;
}

export function createReplyMediaPathNormalizer(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  messageProvider?: string;
  accountId?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  requesterSenderId?: string;
  requesterSenderName?: string;
  requesterSenderUsername?: string;
  requesterSenderE164?: string;
  /** Authenticated personal-chat owner; other channel staging keeps its own scope. */
  ownerScoped?: boolean;
  runtimeSandbox?: Pick<SandboxContext, "outboundFileAccess">;
  abortSignal?: AbortSignal;
}): (payload: ReplyPayload) => Promise<ReplyPayload> {
  // Prefer an explicit agentId so callers without a resolved sessionKey (e.g.
  // `openclaw agent --deliver` with `--reply-channel/--reply-to`) still get
  // the stricter agent-scoped file-read policy applied during staging.
  const agentId =
    params.agentId ??
    (params.sessionKey
      ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
      : undefined);
  const maxBytes = resolveOutboundMediaMaxBytes({
    cfg: params.cfg,
    channel: params.messageProvider,
    accountId: params.accountId,
  });
  let sandboxRootPromise: Promise<string | undefined> | undefined;
  const persistedMediaBySource = new Map<string, Promise<string>>();
  const stagedLocalPaths = new Set<string>();

  const resolveSandboxRoot = async (): Promise<string | undefined> => {
    if (!sandboxRootPromise) {
      sandboxRootPromise = ensureSandboxWorkspaceForSession({
        config: params.cfg,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      }).then((sandbox) => sandbox?.workspaceDir);
    }
    return await sandboxRootPromise;
  };

  const resolveMediaAccessForSource = (media: string) =>
    resolveAgentScopedOutboundMediaAccess({
      cfg: params.cfg,
      agentId,
      workspaceDir: params.workspaceDir,
      mediaSources: [media],
      sessionKey: params.sessionKey,
      messageProvider: params.sessionKey ? undefined : params.messageProvider,
      accountId: params.accountId,
      requesterSenderId: params.requesterSenderId,
      requesterSenderName: params.requesterSenderName,
      requesterSenderUsername: params.requesterSenderUsername,
      requesterSenderE164: params.requesterSenderE164,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
    });

  const persistLocalReplyMedia = async (media: string): Promise<string> => {
    if (!params.runtimeSandbox?.outboundFileAccess && !isLikelyLocalMediaSource(media)) {
      return media;
    }
    const managedMediaPath = await resolveAllowedManagedMediaPath(media);
    if (managedMediaPath) {
      return managedMediaPath;
    }
    const cached = persistedMediaBySource.get(media);
    if (cached) {
      return await cached;
    }
    const runtimeAccess = params.runtimeSandbox?.outboundFileAccess;
    const persistPromise = (
      runtimeAccess
        ? resolveOutboundAttachmentFromRuntime(media, maxBytes, {
            fileAccess: runtimeAccess,
            signal: params.abortSignal,
          })
        : resolveOutboundAttachmentFromUrl(media, maxBytes, {
            mediaAccess: resolveMediaAccessForSource(media),
          })
    )
      .then((saved) => {
        stagedLocalPaths.add(saved.path);
        return saved.path;
      })
      .catch((err: unknown) => {
        persistedMediaBySource.delete(media);
        throw err;
      });
    persistedMediaBySource.set(media, persistPromise);
    return await persistPromise;
  };

  const resolveWorkspaceRelativeMedia = (media: string): string => {
    const relativeWorkspacePath = toRelativeWorkspacePath(params.workspaceDir, media, {
      cwd: params.workspaceDir,
    });
    return resolvePathFromInput(relativeWorkspacePath, params.workspaceDir);
  };

  const resolveAbsoluteWorkspaceMedia = (media: string): string | undefined => {
    if (FILE_URL_RE.test(media) || (!path.isAbsolute(media) && !WINDOWS_DRIVE_RE.test(media))) {
      return undefined;
    }
    try {
      return resolveWorkspaceRelativeMedia(media);
    } catch {
      return undefined;
    }
  };

  const normalizeMediaSource = async (raw: string): Promise<string> => {
    const media = raw.trim();
    if (!media) {
      return media;
    }
    assertMediaNotDataUrl(media);
    if (isPassThroughRemoteMediaSource(media)) {
      return media;
    }
    if (params.runtimeSandbox?.outboundFileAccess) {
      return await persistLocalReplyMedia(media);
    }
    const absoluteWorkspaceMedia = resolveAbsoluteWorkspaceMedia(media);
    if (absoluteWorkspaceMedia) {
      return await persistLocalReplyMedia(absoluteWorkspaceMedia);
    }
    const isRelativeLocalMedia =
      isLikelyLocalMediaSource(media) &&
      !FILE_URL_RE.test(media) &&
      !media.startsWith("~") &&
      !path.isAbsolute(media) &&
      !WINDOWS_DRIVE_RE.test(media);
    const sandboxRoot = await resolveSandboxRoot();
    if (sandboxRoot) {
      let sandboxResolvedMedia: string;
      try {
        sandboxResolvedMedia = await resolveSandboxedMediaSource({
          media,
          sandboxRoot,
        });
      } catch (err) {
        if (FILE_URL_RE.test(media)) {
          throw new Error(
            "Host-local MEDIA file URLs are blocked in normal replies. Use a safe path or the message tool.",
            { cause: err },
          );
        }
        throw err;
      }
      return await persistLocalReplyMedia(sandboxResolvedMedia);
    }
    if (isRelativeLocalMedia) {
      return await persistLocalReplyMedia(resolveWorkspaceRelativeMedia(media));
    }
    if (!isLikelyLocalMediaSource(media)) {
      return media;
    }
    if (FILE_URL_RE.test(media)) {
      throw new Error(
        "Host-local MEDIA file URLs are blocked in normal replies. Use a safe path or the message tool.",
      );
    }
    return await persistLocalReplyMedia(media);
  };

  const normalizePayload = async (payload: ReplyPayload): Promise<ReplyPayload> => {
    const mediaList = getPayloadMediaList(payload);
    if (mediaList.length === 0) {
      return payload;
    }

    const normalizedMedia: string[] = [];
    const seen = new Set<string>();
    let firstMediaDropError: unknown;
    for (const media of mediaList) {
      let normalized: string;
      try {
        normalized = await normalizeMediaSource(media);
      } catch (err) {
        firstMediaDropError ??= err;
        logVerbose(`dropping blocked reply media ${media}: ${String(err)}`);
        continue;
      }
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      normalizedMedia.push(normalized);
    }

    const text =
      firstMediaDropError === undefined
        ? payload.text
        : appendReplyMediaFailureWarning(payload.text);

    if (normalizedMedia.length === 0) {
      return setReplyPayloadMetadata(
        copyReplyPayloadMetadata(payload, {
          ...payload,
          text,
          mediaUrl: undefined,
          mediaUrls: undefined,
        }),
        {
          stagedLocalMediaUrls: undefined,
          mediaPublishAuthority: undefined,
          mediaFailure:
            firstMediaDropError !== undefined || getReplyPayloadMetadata(payload)?.mediaFailure,
        },
      );
    }

    const normalizedPayload = copyReplyPayloadMetadata(payload, {
      ...payload,
      text,
      mediaUrl: normalizedMedia[0],
      mediaUrls: normalizedMedia,
    });
    const previousStagedUrls = getReplyPayloadMetadata(payload)?.stagedLocalMediaUrls ?? [];
    // Staging owns this read-authorization fact. Later projection must not infer
    // ownership from a shared-store path or retain facts about dropped URLs.
    const stagedLocalMediaUrls = normalizedMedia.filter(
      (media) => stagedLocalPaths.has(media) || previousStagedUrls.includes(media),
    );
    const previousAuthority = previousStagedUrls.some((media) => normalizedMedia.includes(media))
      ? getReplyPayloadMetadata(payload)?.mediaPublishAuthority
      : undefined;
    const backendAuthority = params.runtimeSandbox?.outboundFileAccess?.assertCurrentAuthority;
    const currentAuthority =
      normalizedMedia.some((media) => stagedLocalPaths.has(media)) &&
      (backendAuthority || params.abortSignal)
        ? async () => {
            params.abortSignal?.throwIfAborted();
            await backendAuthority?.();
            params.abortSignal?.throwIfAborted();
          }
        : undefined;
    // A stored copy keeps its producer's authority. Re-normalizing it under
    // another attempt must never relabel it as that attempt's successful read.
    const mediaPublishAuthority =
      previousAuthority && currentAuthority && previousAuthority !== currentAuthority
        ? async () => {
            await previousAuthority();
            await currentAuthority();
          }
        : (previousAuthority ?? currentAuthority);
    return setReplyPayloadMetadata(normalizedPayload, {
      stagedLocalMediaUrls: stagedLocalMediaUrls.length ? stagedLocalMediaUrls : undefined,
      mediaPublishAuthority,
      mediaFailure:
        firstMediaDropError !== undefined || getReplyPayloadMetadata(payload)?.mediaFailure,
    });
  };
  return (payload) =>
    params.ownerScoped && agentId
      ? withAgentMediaContext(agentId, () => normalizePayload(payload))
      : normalizePayload(payload);
}

export type ReplyMediaContext = {
  normalizePayload: (payload: ReplyPayload) => Promise<ReplyPayload>;
  setSandbox?: (sandbox: Pick<SandboxContext, "outboundFileAccess"> | null) => void;
};

export function createReplyMediaContext(
  params: Parameters<typeof createReplyMediaPathNormalizer>[0],
): ReplyMediaContext {
  let normalizePayload = createReplyMediaPathNormalizer(params);
  return {
    normalizePayload: (payload) => normalizePayload(payload),
    setSandbox: (sandbox) => {
      // An attempt owns its prepared reader and source cache. A fallback must
      // never reinterpret the preceding attempt's runtime paths.
      normalizePayload = createReplyMediaPathNormalizer({
        ...params,
        runtimeSandbox: sandbox ?? undefined,
      });
    },
  };
}
