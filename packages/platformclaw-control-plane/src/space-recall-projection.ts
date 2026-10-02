import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { ControlPlaneStateError } from "./contracts.js";

export type SpaceRecallWindow = {
  operation: string;
  limit?: number;
  cursor?: string;
  messageId?: string;
  messageOffset?: number;
  bodyLimitBytes?: number;
};
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function assertSpaceTextOffset(text: string, offset: number): void {
  if (truncateUtf16Safe(text, offset).length !== offset) {
    throw new ControlPlaneStateError(
      "Text offset splits a Unicode character; use the returned continuation offset",
    );
  }
}

/** JSON cost includes quotes/escapes; cuts never split a surrogate pair. */
function boundedText(value: string, bytes: number): string {
  if (jsonBytes(value) <= bytes) {
    return value;
  }
  let low = 0,
    high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(truncateUtf16Safe(value, middle)) <= bytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return truncateUtf16Safe(value, low);
}

export function validateSpaceRecallWindow(params: SpaceRecallWindow): void {
  const maxLimit = params.operation === "search" ? 20 : 8;
  if (
    (params.limit !== undefined &&
      (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > maxLimit)) ||
    (params.bodyLimitBytes !== undefined &&
      (!Number.isInteger(params.bodyLimitBytes) ||
        params.bodyLimitBytes < 64 ||
        params.bodyLimitBytes > 8000)) ||
    (params.messageOffset !== undefined &&
      (!params.messageId ||
        !Number.isInteger(params.messageOffset) ||
        params.messageOffset < 0 ||
        params.messageOffset > 16000)) ||
    (params.cursor !== undefined &&
      (params.operation !== "search" ||
        !/^(?:0|[1-9]\d?)$/u.test(params.cursor) ||
        Number(params.cursor) > 20))
  ) {
    throw new ControlPlaneStateError("Invalid Space recall window");
  }
}

/** Model-visible recall has one bounded, serialized envelope rather than accumulating pages. */
export function projectSpaceRecallResult(
  raw: unknown,
  params: SpaceRecallWindow,
): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new ControlPlaneStateError("Space recall unavailable");
  }
  if (params.operation === "search") {
    const candidates = Array.isArray(raw.results) ? raw.results.filter(isRecord).slice(0, 20) : [];
    const offset = params.cursor ? Number(params.cursor) : 0;
    const limit = params.limit ?? 5;
    const maxBytes = limit > 5 ? 16 * 1024 : 8 * 1024;
    const results: Record<string, unknown>[] = [];
    const result: Record<string, unknown> = {
      results,
      indexing: raw.indexing === true,
      truncated: false,
      count: 0,
      moreAvailable: candidates.length > offset,
      windowLimited: candidates.length >= 20 || raw.windowLimited === true,
      guidance:
        "Read a returned source for detail; narrow the query for evidence beyond this bounded candidate window.",
    };
    for (const candidate of candidates.slice(offset, offset + limit)) {
      const snippet =
        typeof candidate.snippet === "string" ? boundedText(candidate.snippet, 800) : "";
      const item = {
        ...candidate,
        snippet,
        ...(typeof candidate.ownerName === "string"
          ? { ownerName: boundedText(candidate.ownerName, 256) }
          : {}),
        truncated: snippet !== candidate.snippet,
      };
      results.push(item);
      // Reserve metadata before measuring so the final envelope cannot exceed the limit.
      result.count = results.length;
      result.moreAvailable = offset + results.length < candidates.length;
      result.nextCursor = String(offset + results.length);
      if (jsonBytes(result) > maxBytes) {
        results.pop();
        break;
      }
    }
    result.count = results.length;
    result.moreAvailable = offset + results.length < candidates.length;
    if (result.moreAvailable && results.length) {
      result.nextCursor = String(offset + results.length);
    } else {
      delete result.nextCursor;
    }
    result.truncated =
      result.moreAvailable === true ||
      result.windowLimited === true ||
      results.some((item) => item.truncated);
    return result;
  }
  if (!isRecord(raw.page) || typeof raw.page.body !== "string") {
    throw new ControlPlaneStateError("Space Page unavailable");
  }
  const page = { ...raw.page };
  const previousBody = raw.page.body;
  page.body = boundedText(previousBody, params.bodyLimitBytes ?? 4000);
  const updatePageContinuation = () => {
    if (typeof page.body === "string" && page.body.length < previousBody.length) {
      page.nextBodyOffset = Number(page.bodyOffset ?? 0) + page.body.length;
      page.truncated = true;
    }
  };
  updatePageContinuation();
  const allMessages = Array.isArray(raw.messages) ? raw.messages.filter(isRecord) : [];
  const limit = params.limit ?? 5;
  const anchor = params.messageId
    ? allMessages.findIndex((message) => message.id === params.messageId)
    : -1;
  if (params.messageId && anchor < 0) {
    throw new ControlPlaneStateError(
      "Requested source message is unavailable; narrow the search or read another source",
    );
  }
  const start =
    anchor < 0
      ? Math.max(0, allMessages.length - limit)
      : Math.max(0, anchor - Math.floor(limit / 2));
  const selected =
    params.messageOffset !== undefined
      ? [allMessages[anchor]!]
      : allMessages.slice(start, start + limit);
  const messages = selected.map((message) => {
    const original = typeof message.text === "string" ? message.text : "";
    const offset = message.id === params.messageId ? (params.messageOffset ?? 0) : 0;
    if (offset > original.length) {
      throw new ControlPlaneStateError("Message offset exceeds the bounded source excerpt");
    }
    assertSpaceTextOffset(original, offset);
    const text = boundedText(original.slice(offset), 800);
    return {
      ...message,
      text,
      ...(typeof message.authorName === "string"
        ? { authorName: boundedText(message.authorName, 256) }
        : {}),
      messageOffset: offset,
      nextMessageOffset: offset + text.length < original.length ? offset + text.length : null,
      truncated: offset + text.length < original.length || offset > 0,
    };
  });
  const result: Record<string, unknown> = {
    ...raw,
    page,
    ...(raw.messages === undefined ? {} : { messages }),
    ...(isRecord(raw.conversation) && typeof raw.conversation.ownerName === "string"
      ? {
          conversation: {
            ...raw.conversation,
            ownerName: boundedText(raw.conversation.ownerName, 256),
          },
        }
      : {}),
    moreAvailable:
      allMessages.length > selected.length ||
      messages.some((message) => message.truncated) ||
      page.truncated === true,
    sourceWindow: { maxMessages: 100, maxTextChars: 16000 },
  };
  const maxBytes = limit > 5 || (params.bodyLimitBytes ?? 4000) > 4000 ? 24 * 1024 : 16 * 1024;
  if (jsonBytes(result) > maxBytes) {
    // Metadata has its own bounded producers. Unexpected oversized envelopes fail closed
    // instead of flooding model context or silently dropping an anchored source.
    throw new ControlPlaneStateError(
      "Space source metadata exceeds the recall budget; narrow the source request",
    );
  }
  return result;
}
