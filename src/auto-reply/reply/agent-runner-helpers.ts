/** Helper predicates and gates used while streaming agent-runner payloads. */
import { isAudioFileName } from "@openclaw/media-core/mime";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { hasPendingAgentQuestionAnswer } from "../../agents/harness/gateway-question.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import type { TypingSignaler } from "./typing-mode.js";

const hasAudioMedia = (urls?: string[]): boolean =>
  Boolean(urls?.some((url) => isAudioFileName(url)));

export function createUnavailableQuestionReply(): ReplyPayload {
  const payload = {
    isError: true,
    text: "This answer belongs to a question that is no longer available. Check the latest question and answer again.",
  };
  setReplyPayloadMetadata(payload, { noVisibleReplyReason: "question-unavailable" });
  return payload;
}

/** Fixed-choice parsing needs the original answer, before the steering envelope. */
export function resolveQuestionAnswerSteerText(
  followupRun: FollowupRun,
  sessionKey: string,
): string {
  const text = followupRun.transcriptPrompt ?? followupRun.prompt;
  return !(followupRun.images?.length || followupRun.media?.length) &&
    hasPendingAgentQuestionAnswer({ sessionKey, text })
    ? text
    : followupRun.prompt;
}

/** Returns true when a payload carries audio media. */
export const isAudioPayload = (payload: ReplyPayload): boolean =>
  hasAudioMedia(resolveSendableOutboundReplyParts(payload).mediaUrls);

type VerboseGateParams = {
  sessionKey?: string;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
};

const VERBOSE_GATE_SESSION_REFRESH_MS = 250;

function readCurrentVerboseLevel(params: VerboseGateParams): VerboseLevel | undefined {
  if (!params.sessionKey || !params.storePath) {
    return undefined;
  }
  try {
    const entry = loadSessionEntryReadOnly({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      clone: false,
    });
    return typeof entry?.verboseLevel === "string"
      ? normalizeVerboseLevel(entry.verboseLevel)
      : undefined;
  } catch {
    // ignore store read failures
    return undefined;
  }
}

function createCurrentVerboseLevelResolver(
  params: VerboseGateParams,
): () => VerboseLevel | undefined {
  let cachedLevel: VerboseLevel | undefined;
  let cachedAtMs = Number.NEGATIVE_INFINITY;
  return () => {
    if (!params.sessionKey || !params.storePath) {
      return undefined;
    }
    const now = Date.now();
    if (now - cachedAtMs < VERBOSE_GATE_SESSION_REFRESH_MS) {
      return cachedLevel;
    }
    cachedLevel = readCurrentVerboseLevel(params);
    cachedAtMs = now;
    return cachedLevel;
  };
}

function createVerboseGate(
  params: VerboseGateParams,
  shouldEmit: (level: VerboseLevel) => boolean,
): () => boolean {
  // Normalize verbose values from session store/config so false/"false" still means off.
  const fallbackVerbose = params.resolvedVerboseLevel;
  const resolveCurrentVerboseLevel = createCurrentVerboseLevelResolver(params);
  return () => {
    return shouldEmit(resolveCurrentVerboseLevel() ?? fallbackVerbose);
  };
}

/** Creates the visibility gate for tool result summaries. */
export const createShouldEmitToolResult = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level !== "off");
};

/** Creates the visibility gate for command/tool output streams. */
export const createShouldEmitToolOutput = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level === "full");
};

/** Sends typing signals for visible text payloads when typing is enabled. */
export const signalTypingIfNeeded = async (
  payloads: ReplyPayload[],
  typingSignals: TypingSignaler,
): Promise<void> => {
  const shouldSignalTyping = payloads.some((payload) =>
    hasOutboundReplyContent(payload, { trimText: true }),
  );
  if (shouldSignalTyping) {
    await typingSignals.signalRunStart();
  }
};
