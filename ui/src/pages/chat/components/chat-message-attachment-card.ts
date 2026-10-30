import { html } from "lit";
import { icons } from "../../../components/icons.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";

export function renderAssistantAttachmentCard(params: { url: string; label: string }) {
  const downloadHref = safeAttachmentHref(params.url);
  return html`
    <div class="chat-assistant-attachment-card">
      <span class="chat-assistant-attachment-card__icon">${icons.paperclip}</span>
      ${downloadHref
        ? html`<a
            class="chat-assistant-attachment-card__link"
            href=${downloadHref}
            target="_blank"
            rel="noreferrer"
            >${params.label}</a
          >`
        : html`<span class="chat-assistant-attachment-card__title">${params.label}</span>`}
    </div>
  `;
}
