// Normalizes direct cron payloads before TTS, custody, transport, or mirroring.
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import {
  resolveDirectCronFallbackSourceIndex,
  resolveDirectCronSummaryFallbackText,
  shouldAttachDirectCronFallbackText,
} from "./delivery-dispatch-awareness.js";
import { normalizeSilentReplyText } from "./delivery-dispatch-policy.js";

function normalizeDirectPayload(payload: ReplyPayload): ReplyPayload {
  const normalized = payload.text ? normalizeSilentReplyText(payload.text) : undefined;
  return normalized
    ? {
        ...payload,
        text: normalized.strippedTrailingSilentToken ? undefined : normalized.text,
      }
    : payload;
}

export function normalizeDirectCronDeliveryPayloads(params: {
  deliveryPayloads: ReplyPayload[];
  outputText?: string;
  summary?: string;
  synthesizedText?: string;
}): ReplyPayload[] {
  const summaryFallbackText = resolveDirectCronSummaryFallbackText(params);
  const normalizedSummaryFallback = summaryFallbackText
    ? normalizeSilentReplyText(summaryFallbackText)
    : undefined;
  const fallbackText =
    normalizedSummaryFallback?.strippedTrailingSilentToken === true
      ? undefined
      : normalizedSummaryFallback?.text;
  const candidates = params.deliveryPayloads
    .map(normalizeDirectPayload)
    .filter((payload) => hasReplyPayloadContent(payload, { trimText: true }));
  const existingFallbackSourceIndex = resolveDirectCronFallbackSourceIndex(
    candidates,
    fallbackText,
  );
  const needsFallbackSource =
    Boolean(fallbackText) &&
    candidates.some(shouldAttachDirectCronFallbackText) &&
    existingFallbackSourceIndex === undefined;
  const fallbackSourceIndex = needsFallbackSource ? 0 : existingFallbackSourceIndex;
  const payloads = needsFallbackSource ? [{ text: fallbackText }, ...candidates] : candidates;
  const normalizedPayloads = payloads.map((payload) =>
    shouldAttachDirectCronFallbackText(payload) && fallbackText
      ? Object.assign({}, payload, {
          fallbackText: {
            text: fallbackText,
            ...(fallbackSourceIndex !== undefined
              ? { replacesPayloadIndex: fallbackSourceIndex }
              : {}),
          },
        })
      : payload,
  );
  if (normalizedPayloads.length === 0 && fallbackText) {
    return [{ text: fallbackText }];
  }
  return normalizedPayloads;
}
