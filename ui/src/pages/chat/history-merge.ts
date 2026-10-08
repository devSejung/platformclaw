import {
  createSessionProjection,
  reconcileSessionProjectionSnapshot,
  reduceSessionProjection,
  type SessionProjectionEvent,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import { matchesCompactionOperation } from "./chat-progress.ts";
import type { CompactionStatus } from "./tool-stream.ts";

const chatSessionProjections = new WeakMap<object, SessionProjectionState>();
const projectionScopeKeys = [
  "sessionKey",
  "sessionId",
  "agentId",
  "lifecycleRevision",
  "activeLeafEntryId",
] as const;

function changedProjectionScope(current: SessionProjectionState, scope: SessionProjectionScope) {
  return projectionScopeKeys.filter(
    (key) =>
      Object.hasOwn(scope, key) &&
      current.scope[key] !== undefined &&
      current.scope[key] !== scope[key],
  );
}

type CompactionProjectionOwner = {
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: number | null;
};

export function resetChatCompactionProjection(owner: CompactionProjectionOwner): void {
  if (owner.compactionClearTimer != null) {
    clearTimeout(owner.compactionClearTimer);
    owner.compactionClearTimer = null;
  }
  owner.compactionStatus = null;
}

type ChatSessionProjectionOwner = {
  sessionKey: string;
  chatMessages: unknown[];
  currentSessionId?: string | null;
  chatDisplayedLeafEntryId?: string | null;
};

type ChatSessionProjectionScopeOptions = Omit<SessionProjectionScope, "sessionId"> & {
  sessionId?: string | null;
};

/** Every live, pending, terminal, and history path must identify the same pane and branch. */
export function readChatSessionProjectionScope(
  owner: ChatSessionProjectionOwner,
  options: ChatSessionProjectionScopeOptions = {},
): SessionProjectionScope {
  const sessionId = Object.hasOwn(options, "sessionId")
    ? options.sessionId
    : owner.currentSessionId;
  return {
    sessionKey: options.sessionKey ?? owner.sessionKey,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(options.lifecycleRevision !== undefined
      ? { lifecycleRevision: options.lifecycleRevision }
      : {}),
    ...(Object.hasOwn(options, "activeLeafEntryId") ||
    Object.hasOwn(owner, "chatDisplayedLeafEntryId")
      ? {
          activeLeafEntryId: Object.hasOwn(options, "activeLeafEntryId")
            ? (options.activeLeafEntryId ?? null)
            : (owner.chatDisplayedLeafEntryId ?? null),
        }
      : {}),
  };
}

/** One pane owns its shared-reducer projection; split panes never share live state. */
export function getChatSessionProjection(
  owner: object,
  messages: readonly unknown[] = [],
  scope: SessionProjectionScope = {},
): SessionProjectionState {
  const current = chatSessionProjections.get(owner);
  const scopeChanged = current !== undefined && changedProjectionScope(current, scope).length > 0;
  if (!current || scopeChanged) {
    const projection = createSessionProjection(scope, messages);
    setChatSessionProjection(owner, projection);
    return projection;
  }

  const bindsScope = projectionScopeKeys.some(
    (key) =>
      Object.hasOwn(scope, key) && current.scope[key] === undefined && scope[key] !== undefined,
  );
  // Learning a durable session or leaf binds this pane without reclassifying
  // reducer-owned live entries, pending sends, or active runs as history.
  const scopedProjection = bindsScope
    ? { ...current, scope: { ...current.scope, ...scope } }
    : current;
  const currentMessagesMatch =
    scopedProjection.messages.length === messages.length &&
    scopedProjection.messages.every((message, index) => message === messages[index]);
  const projection = currentMessagesMatch
    ? scopedProjection
    : reconcileSessionProjectionSnapshot(scopedProjection, messages, scope);
  if (projection !== current) {
    chatSessionProjections.set(owner, projection);
  }
  return projection;
}

export function setChatSessionProjection(owner: object, projection: SessionProjectionState): void {
  const current = chatSessionProjections.get(owner);
  const statusOwner = owner as CompactionProjectionOwner;
  if (current) {
    const changed = changedProjectionScope(current, projection.scope);
    const status = statusOwner.compactionStatus;
    // A compacted marker advances the active leaf. Keep its live identity through
    // that handoff, but never carry transient status into another session or branch.
    if (
      changed.length > 0 &&
      (changed.some((key) => key !== "activeLeafEntryId") ||
        !status ||
        !projection.messages.some((message) => matchesCompactionOperation(message, status)))
    ) {
      resetChatCompactionProjection(statusOwner);
    }
  }
  chatSessionProjections.set(owner, projection);
}

/** Publish the reducer and rendered transcript together; no caller maintains a second copy. */
export function reduceChatSessionProjection(
  owner: ChatSessionProjectionOwner,
  event: SessionProjectionEvent,
  options: {
    scope?: SessionProjectionScope;
    messages?: readonly unknown[];
  } = {},
): SessionProjectionState {
  const scope = options.scope ?? readChatSessionProjectionScope(owner);
  const previous = chatSessionProjections.get(owner);
  // A history snapshot can advance the compacted leaf. Publish its marker and
  // scope together so an intermediate empty projection cannot retire the live row.
  const current =
    previous && changedProjectionScope(previous, scope).length > 0
      ? createSessionProjection(scope, options.messages ?? owner.chatMessages)
      : getChatSessionProjection(owner, options.messages ?? owner.chatMessages, scope);
  const projection = reduceSessionProjection(current, { ...event, scope });
  if (event.type === "sessionReset") {
    resetChatCompactionProjection(owner as CompactionProjectionOwner);
  }
  if (projection !== current || current !== previous) {
    setChatSessionProjection(owner, projection);
    owner.chatMessages = [...projection.messages];
  }
  return projection;
}
