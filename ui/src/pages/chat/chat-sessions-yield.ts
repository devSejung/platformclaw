import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import { t } from "../../i18n/index.ts";
import type { ChatItem, ToolCard } from "../../lib/chat/chat-types.ts";
import { isStandaloneToolMessageForDisplay } from "../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached, isToolCardError } from "../../lib/chat/tool-cards.ts";
import { coalesceToolActivityMessages } from "./chat-thread-grouping.ts";
import {
  buildMessageKeys,
  rawMessageTimestamp,
  safeNormalizeMessage,
} from "./chat-thread-items.ts";

function isSuccessfulYield(card: ToolCard): boolean {
  if (card.completed !== true || card.isError === true) {
    return false;
  }
  if (asRecord(card.details)?.status === "yielded") {
    return true;
  }
  try {
    return asRecord(JSON.parse(card.outputText ?? ""))?.status === "yielded";
  } catch {
    return false;
  }
}

export function projectSessionsYieldItems(
  items: ChatItem[],
  activeRun?: { runId?: string | null; startedAt?: number | null },
  showToolCalls = true,
): ChatItem[] {
  const projected: ChatItem[][] = [];
  let laterActivity = false;
  const laterRuns = new Set<string>();
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const message = item.kind === "message" ? asRecord(item.message) : null;
    const cards = message ? extractToolCardsCached(message) : [];
    const yieldCards = cards.filter((card) => card.name === "sessions_yield");
    const successful = yieldCards.filter(isSuccessfulYield);
    const confirmed = successful.filter((card) => Object.hasOwn(card, "args"));
    const timestamp = message ? rawMessageTimestamp(message) : null;
    const runId = message
      ? readSessionMessageIdentity(message, {
          runId: asRecord(message["__openclaw"])?.runId ?? message.runId,
        })?.runId
      : null;
    const markers: ChatItem[] = confirmed.toReversed().map((card) => {
      const resumed =
        laterActivity ||
        (runId != null && [...laterRuns].some((laterRun) => laterRun !== runId)) ||
        (activeRun !== undefined &&
          ((runId != null && activeRun.runId != null && activeRun.runId !== runId) ||
            (timestamp !== null &&
              activeRun.startedAt != null &&
              activeRun.startedAt > timestamp)));
      laterActivity = true;
      return {
        kind: "notice",
        key: `yield:${item.key}:${card.id}`,
        sessionsYield: resumed ? "resumed" : "waiting",
        text: t(resumed ? "chat.yieldResumed" : "chat.yieldWaiting"),
        timestamp: timestamp ?? 0,
      };
    });
    markers.reverse();
    let remaining: ChatItem[] = [item];
    if (message && yieldCards.length > 0) {
      // Inputs and results can both echo private continuation context. Classify
      // blocks through the same extractor that accepts legacy/implicit calls.
      if (isStandaloneToolMessageForDisplay(message)) {
        remaining = [];
      } else if (Array.isArray(message.content)) {
        const yieldIds = new Set(yieldCards.map((card) => card.callId));
        const content = message.content.filter((block: unknown) => {
          const blockCards = extractToolCardsCached({ role: "assistant", content: [block] });
          return !blockCards.some(
            (card) =>
              !showToolCalls ||
              card.name === "sessions_yield" ||
              (card.callId !== undefined && yieldIds.has(card.callId)),
          );
        });
        remaining = content.length
          ? [
              {
                ...item,
                kind: "message",
                message: {
                  ...message,
                  content,
                  details: undefined,
                  error: undefined,
                  errorMessage: undefined,
                },
              },
            ]
          : [];
      }
    }
    // Error text is untrusted too: a rejected call can echo its inputs. Keep a
    // visible failure without copying raw output, details, or arguments.
    const failures: ChatItem[] = showToolCalls
      ? yieldCards.filter(isToolCardError).map((card) => ({
          kind: "message",
          key: `yield-error:${item.key}:${card.id}`,
          message: {
            role: "toolResult",
            toolCallId: card.callId,
            toolName: "sessions_yield",
            content: [{ type: "text", text: t("chat.yieldFailed") }],
            isError: true,
            ...(timestamp === null ? {} : { timestamp }),
          },
        }))
      : [];
    projected.push([...remaining, ...failures, ...markers]);
    if (runId) {
      laterRuns.add(runId);
    }
    const role = message?.role;
    laterActivity ||=
      role === "user" ||
      item.kind === "stream" ||
      (role === "assistant" &&
        (safeNormalizeMessage(message)?.content.some(
          (block) => !isToolCallContentType(block.type) && !isToolResultContentType(block.type),
        ) ??
          false));
  }
  return projected.toReversed().flat();
}

const yieldTimestampByHistory = new WeakMap<readonly unknown[], number | null>();

/** Reuse transcript pairing, and never rescan unchanged history on timer/push updates. */
export function latestSessionsYieldTimestamp(messages: readonly unknown[]): number | null {
  if (yieldTimestampByHistory.has(messages)) {
    return yieldTimestampByHistory.get(messages) ?? null;
  }
  const keys = buildMessageKeys([...messages]);
  const items: ChatItem[] = messages.map((message, index) => ({
    kind: "message",
    key: keys[index]!,
    message,
  }));
  const marker = projectSessionsYieldItems(coalesceToolActivityMessages(items)).findLast(
    (item) => item.kind === "notice" && item.sessionsYield === "waiting",
  );
  const timestamp = marker?.kind === "notice" && marker.timestamp > 0 ? marker.timestamp : null;
  yieldTimestampByHistory.set(messages, timestamp);
  return timestamp;
}
