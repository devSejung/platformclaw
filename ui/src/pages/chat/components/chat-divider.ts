import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { renderChatTimestamp } from "./chat-message-timestamp.ts";

export function renderChatDivider(
  item: Extract<ChatItem, { kind: "divider" }>,
  onOpenSessionCheckpoints?: () => void | Promise<void>,
) {
  return html`
    <div
      class="chat-divider ${item.compaction
        ? `chat-compaction chat-compaction--${item.compaction}`
        : ""}"
      data-chat-row-key=${item.key}
      data-ts=${String(item.timestamp)}
    >
      <div
        class="chat-divider__rule"
        role=${item.compaction ? "status" : "separator"}
        aria-live=${item.compaction ? "polite" : nothing}
        aria-label=${[item.label, item.metric, item.description].filter(Boolean).join(", ")}
      >
        <span class="chat-divider__line"></span>
        <span class="chat-divider__label">
          ${item.compaction
            ? html`<span class="chat-compaction__glyph" aria-hidden="true">
                <span class="chat-compaction__line"></span>
                <span class="chat-compaction__line"></span>
                <span class="chat-compaction__line"></span>
                <span class="chat-compaction__line"></span>
                <span class="chat-compaction__line"></span>
                ${item.compaction === "failed"
                  ? icons.alertTriangle
                  : item.compaction === "aborted"
                    ? icons.x
                    : icons.check}
              </span>`
            : nothing}
          <span class="chat-divider__title">${item.label}</span>
          ${item.metric
            ? html`
                <span class="chat-divider__separator" aria-hidden="true">·</span>
                <span class="chat-divider__metric">${item.metric}</span>
              `
            : nothing}
          ${item.action?.kind === "session-checkpoints" && onOpenSessionCheckpoints
            ? html`<button
                type="button"
                class="btn btn--subtle btn--sm chat-divider__action"
                @click=${() => onOpenSessionCheckpoints()}
              >
                ${item.action.label}
              </button>`
            : nothing}
        </span>
        <span class="chat-divider__line"></span>
      </div>
      ${item.description
        ? html`
            <div class="chat-divider__details">
              ${item.description
                ? html`<span class="chat-divider__description">${item.description}</span>`
                : nothing}
            </div>
          `
        : nothing}
    </div>
  `;
}

export function renderChatNotice(item: Extract<ChatItem, { kind: "notice" }>) {
  if (item.sessionsYield) {
    return html`<div
      class="chat-notice chat-yield-marker"
      data-chat-row-key=${item.key}
      data-ts=${String(item.timestamp)}
    >
      <span class="chat-yield-marker__icon" aria-hidden="true">${icons.hourglass}</span>
      <span>${item.text}</span>
      ${item.timestamp > 0 ? renderChatTimestamp(item.timestamp) : nothing}
    </div>`;
  }
  return html`
    <div class="chat-notice" data-chat-row-key=${item.key} data-ts=${String(item.timestamp)}>
      <div class="chat-text" dir=${detectTextDirection(item.text)}>
        ${unsafeHTML(toSanitizedMarkdownHtml(item.text, { codeBlockChrome: "none" }))}
      </div>
    </div>
  `;
}
