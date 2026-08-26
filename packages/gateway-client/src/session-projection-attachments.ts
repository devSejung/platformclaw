import { readNonemptyString, readRecord } from "./session-projection-values.js";
import type { SessionProjectionEntry } from "./session-projection.js";

function isAttachmentContentBlock(value: unknown): boolean {
  const block = readRecord(value);
  return (
    block?.type === "attachment" && readNonemptyString(readRecord(block.attachment)?.url) !== null
  );
}

export function carryPendingUserAttachments(
  pending: SessionProjectionEntry,
  incoming: SessionProjectionEntry,
): SessionProjectionEntry | null {
  if (!pending.pending || pending.identity?.role !== "user" || incoming.identity?.role !== "user") {
    return null;
  }
  const pendingRecord = readRecord(pending.message);
  const incomingRecord = readRecord(incoming.message);
  const pendingContent = pendingRecord?.content;
  if (!pendingRecord || !incomingRecord || !Array.isArray(pendingContent)) {
    return null;
  }
  const carried = pendingContent.filter(isAttachmentContentBlock);
  if (carried.length === 0) {
    return null;
  }
  const incomingMedia = readRecord(incomingRecord["__openclaw"])?.media;
  const incomingContent = incomingRecord.content;
  if (
    (Array.isArray(incomingMedia) && incomingMedia.length > 0) ||
    (Array.isArray(incomingContent) && incomingContent.some(isAttachmentContentBlock))
  ) {
    return null;
  }
  const content = Array.isArray(incomingContent)
    ? [...incomingContent, ...carried]
    : typeof incomingContent === "string" && incomingContent.length > 0
      ? [{ type: "text", text: incomingContent }, ...carried]
      : carried;
  // ACK can precede attachment persistence. Keep the submitted structured
  // content pending until a later snapshot owns its canonical media fact.
  return {
    ...incoming,
    message: { ...incomingRecord, content },
    pending: true,
    pendingRunId: pending.pendingRunId,
  };
}
