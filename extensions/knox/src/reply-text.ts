import {
  legacyInteractiveReplyToPresentation,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { resolveOutboundMediaUrls, type ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  isBlockedHostnameOrIp,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";

const MAX_ATTACHMENT_SUMMARIES = 10;

async function resolvePublicReplyLink(value: string | undefined): Promise<string | undefined> {
  const raw = value?.trim();
  if (
    !raw ||
    Array.from(raw).some((character) => character.charCodeAt(0) <= 0x20 || character === "\x7f")
  ) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      !url.hostname.includes(".") ||
      isBlockedHostnameOrIp(url.hostname)
    ) {
      return undefined;
    }
    // Media references can name private files or internal hosts. Only share links
    // after the same pinned DNS check used by media-capable channel fallbacks.
    await resolvePinnedHostnameWithPolicy(url.hostname);
    return url.href;
  } catch {
    return undefined;
  }
}

async function sanitizeKnoxPresentationLinks(
  presentation: MessagePresentation | undefined,
): Promise<MessagePresentation | undefined> {
  if (!presentation) {
    return undefined;
  }
  return {
    ...presentation,
    blocks: await Promise.all(
      presentation.blocks.map(async (block) => {
        if (block.type !== "buttons") {
          return block;
        }
        return {
          ...block,
          buttons: await Promise.all(
            block.buttons.map(async (button) => {
              const action = resolveMessagePresentationButtonAction(button);
              if (button.disabled || (action?.type !== "url" && action?.type !== "web-app")) {
                return button;
              }
              const url = await resolvePublicReplyLink(action.url);
              return url ? { ...button, action: { ...action, url } } : { label: button.label };
            }),
          ),
        };
      }),
    ),
  };
}

/** Render portable reply content for Knox's text-only relay without disclosing media paths. */
export async function renderKnoxReplyText(payload: ReplyPayload): Promise<string | undefined> {
  const legacy = normalizeLegacyInteractiveReply(payload.interactive);
  const presentation = await sanitizeKnoxPresentationLinks(
    normalizeMessagePresentation(payload.presentation) ??
      (legacy ? legacyInteractiveReplyToPresentation(legacy) : undefined),
  );
  const body = payload.text?.trim() || payload.fallbackText?.text.trim();
  const presentationText = renderMessagePresentationFallbackText({ presentation });
  // Runtime-authored fallback text already contains the presentation. Rendering
  // it again duplicates question prompts and their numbered choices.
  const text =
    payload.presentationTextMode === "fallback" && body
      ? body
      : body === presentationText
        ? body
        : renderMessagePresentationFallbackText({ text: body, presentation });
  const sections = text ? [text] : [];
  const location = payload.location;
  if (location) {
    sections.push(
      ["📍 위치", location.name, location.address, `${location.latitude}, ${location.longitude}`]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const references = resolveOutboundMediaUrls(payload);
  const attachments = payload.attachments ?? [];
  const media = references.length
    ? references.map((reference, index) => ({ reference, attachment: attachments[index] }))
    : attachments.map((attachment) => ({
        reference: attachment.url ?? attachment.mediaUrl ?? attachment.path ?? attachment.filePath,
        attachment,
      }));
  const summaries = await Promise.all(
    media.slice(0, MAX_ATTACHMENT_SUMMARIES).map(async ({ reference, attachment }) => {
      const link = payload.sensitiveMedia ? undefined : await resolvePublicReplyLink(reference);
      const name = attachment?.name?.trim();
      // Names are optional metadata; a mislabelled path must not become a link
      // or reveal a private workspace just because native upload is unavailable.
      const displayName = name && !/[\\/\r\n]/u.test(name) ? ` (${name})` : "";
      return link
        ? `📎 첨부 파일${displayName}: ${link}`
        : `📎 첨부 파일${displayName}: Knox에서는 직접 표시할 수 없습니다.`;
    }),
  );
  if (media.length > MAX_ATTACHMENT_SUMMARIES) {
    summaries.push(`그 외 첨부 파일 ${media.length - MAX_ATTACHMENT_SUMMARIES}개가 있습니다.`);
  }
  if (summaries.length) {
    sections.push(summaries.join("\n"));
  }
  return sections.join("\n\n") || undefined;
}
