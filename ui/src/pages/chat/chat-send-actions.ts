import type { QueueMode } from "../../../../src/auto-reply/reply/queue/types.js";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { loadChatBranches, loadChatHistory, type ChatState } from "./chat-history.ts";
import {
  flushStoredChatOutbox,
  resumeStoredChatOutboxes as resumeStoredChatOutboxesDrain,
  scheduleStoredChatOutboxDrain,
} from "./chat-outbox-drain.ts";
import {
  admitQueuedMessageForSession,
  isVolatileQueuedMessage,
  updateQueuedMessage,
  updateVolatileQueuedMessage,
} from "./chat-queue.ts";
import type { ChatSendAck } from "./chat-send-ack.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { chatOutboxDrainDependencies, deliverChatQueueItem } from "./chat-send-delivery.ts";
import {
  canSendVolatileQueueItem,
  reconnectSafeQueuedSendState,
  setChatError,
} from "./chat-send-queue-state.ts";
import { isActiveLeafChangedError } from "./chat-send-rejection.ts";
import { requestChatSend, resolveDisplayedLeafEntryId } from "./chat-send-request.ts";
import { listStoredChatOutboxes, storedChatOutboxScopeKey } from "./composer-persistence.ts";
import { formatConnectError } from "./connect-error.ts";
import {
  OFFLINE_QUEUE_STORAGE_ERROR,
  recoverUnconfirmedSteer,
  steerQueuedChatMessage as steerQueuedChatMessageLifecycle,
  type SteerSendDependencies,
  type SteerSendResult,
} from "./steer-lifecycle.ts";
import { isInflightSteer } from "./steered-chip.ts";

export async function sendChatMessageWithGeneratedRunId(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
  options: {
    canApplyError?: () => boolean;
    queueMode?: QueueMode;
    runId?: string;
  } = {},
): Promise<ChatSendAck | null> {
  const result = await attemptChatMessageWithGeneratedRunId(state, message, attachments, options);
  return result.ok ? result.ack : null;
}

async function attemptChatMessageWithGeneratedRunId(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
  options: {
    canApplyError?: () => boolean;
    queueMode?: QueueMode;
    runId?: string;
  } = {},
): Promise<SteerSendResult> {
  if (!state.client || !state.connected) {
    const error = new Error("gateway not connected");
    return { ok: false, error, displayError: error.message };
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    const error = new Error("message is empty");
    return { ok: false, error, displayError: error.message };
  }
  const canApplyError = options.canApplyError ?? (() => true);
  if (canApplyError()) {
    setChatError(state, null);
  }
  const runId = options.runId ?? generateUUID();
  // Direct sends fail closed on the authoritative leaf; restored drains omit it.
  const expectedLeafEntryId = resolveDisplayedLeafEntryId(state);
  try {
    const ack = await requestChatSend(state, {
      message: msg,
      attachments,
      runId,
      ...(expectedLeafEntryId !== undefined ? { expectedLeafEntryId } : {}),
      ...(options.queueMode ? { queueMode: options.queueMode } : {}),
    });
    return { ok: true, ack };
  } catch (err) {
    const displayError = isActiveLeafChangedError(err)
      ? t("chat.sendErrors.activeLeafChanged")
      : formatConnectError(err);
    if (canApplyError()) {
      setChatError(state, displayError);
      if (isActiveLeafChangedError(err)) {
        void Promise.all([loadChatHistory(state), loadChatBranches(state)]);
      }
    }
    return { ok: false, error: err, displayError };
  }
}

function findStoredOutbox(host: ChatHost, id: string) {
  return listStoredChatOutboxes(host).find(({ queue }) => queue.some((item) => item.id === id));
}

const resetRetryState = (
  entry: ChatQueueItem,
  sendState: ChatQueueItem["sendState"],
): ChatQueueItem => ({
  ...entry,
  sendAttempts: 0,
  sendError: undefined,
  sendRequestStartedAtMs: undefined,
  sendRunId: entry.sendState === "failed" ? generateUUID() : entry.sendRunId,
  sendState,
});

export const steerSendDependencies: SteerSendDependencies = {
  loadChatHistory: (host) => void loadChatHistory(host as unknown as ChatState),
  resumeRestoredOutbox: (host, itemId) => {
    const restoredOutbox = findStoredOutbox(host as ChatHost, itemId);
    if (!host.chatRunId && restoredOutbox) {
      void scheduleStoredChatOutboxDrain(
        host as ChatHost,
        restoredOutbox,
        chatOutboxDrainDependencies,
      );
    }
  },
  sendChatMessage: (host, message, attachments, options) =>
    attemptChatMessageWithGeneratedRunId(
      host as unknown as ChatState,
      message,
      attachments,
      options,
    ),
};

export const steerQueuedChatMessage = (host: ChatHost, id: string) =>
  steerQueuedChatMessageLifecycle(host, id, steerSendDependencies);

export async function resumeStoredChatOutboxes(host: ChatHost) {
  const unconfirmedSteer = host.chatQueue.find(
    (item) => item.kind === "steered" && item.sendState === "unconfirmed",
  );
  if (unconfirmedSteer) {
    await recoverUnconfirmedSteer(host, unconfirmedSteer.id, steerSendDependencies);
  }
  await resumeStoredChatOutboxesDrain(host, chatOutboxDrainDependencies);
}

export const flushChatQueueForEvent = (host: ChatHost) =>
  flushStoredChatOutbox(host, chatOutboxDrainDependencies);

export const retryReconnectableQueuedChatSends = resumeStoredChatOutboxes;

export async function retryQueuedChatMessage(host: ChatHost, id: string) {
  const item = host.chatQueue.find((entry) => entry.id === id);
  if (
    !item ||
    item.pendingRunId ||
    item.sendState === "executing-command" ||
    isInflightSteer(item) ||
    item.sendState === "sending" ||
    item.sendState === "waiting-model"
  ) {
    return;
  }
  let outbox = findStoredOutbox(host, item.id);
  if (!outbox) {
    const wasVolatile = isVolatileQueuedMessage(host, item.id);
    if (!admitQueuedMessageForSession(host, item.sessionKey ?? host.sessionKey, item)) {
      if (
        wasVolatile &&
        !item.localCommandName &&
        item.sendRunId &&
        (item.sendState === "failed" || item.sendState === "unconfirmed") &&
        canSendVolatileQueueItem(host, item)
      ) {
        const retry = updateVolatileQueuedMessage(host, id, (entry) =>
          resetRetryState(entry, undefined),
        );
        if (!retry) {
          setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          return;
        }
        await deliverChatQueueItem(host, retry, {
          routingSessionKey: retry.sessionKey ?? host.sessionKey,
          storageMode: "memory",
        });
        return;
      }
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return;
    }
  }
  const retry = updateQueuedMessage(host, id, (entry) =>
    resetRetryState(entry, reconnectSafeQueuedSendState(host)),
  );
  if (!retry) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  outbox = findStoredOutbox(host, retry.id);
  if (!outbox) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  const drain = scheduleStoredChatOutboxDrain(host, outbox, chatOutboxDrainDependencies);
  if (host.chatSending && host.chatSendingScopeKey === storedChatOutboxScopeKey(outbox)) {
    void drain;
    return;
  }
  await drain;
  if (!host.chatRunId) {
    void flushStoredChatOutbox(host, chatOutboxDrainDependencies);
  }
}
