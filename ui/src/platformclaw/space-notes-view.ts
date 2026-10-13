import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { SpacePage } from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { icons } from "../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { platformClawT } from "./i18n.ts";

const t = (key: string) => platformClawT(`platformClaw.spaces.${key}`);

export function renderSpaceNotes(p: {
  page: SpacePage | null;
  canEdit: boolean;
  busy: boolean;
  onEdit: () => void;
  onCreateChild: () => void;
}) {
  return p.page
    ? html`<section class="pc-space-history" aria-label=${t("notes")}>
        <div class="pc-space-message-column pc-space-notes">
          <h3>${p.page.title}</h3>
          <p class="pc-space-panel-hint">${t("sharedNotesNotice")}</p>
          <p class="pc-space-note-meta">
            ${t("revision")} ${p.page.revision} · ${new Date(p.page.updatedAt).toLocaleDateString()}
          </p>
          <div class="markdown-content">
            ${p.page.body
              ? unsafeHTML(toSanitizedMarkdownHtml(p.page.body, { codeBlockChrome: "none" }))
              : html`<p class="pc-space-panel-hint">${t("emptyNotes")}</p>`}
          </div>
          ${p.canEdit
            ? html`<div class="pc-space-note-actions">
                <button class="btn" @click=${p.onEdit}>${icons.penLine}${t("edit")}</button>
                <button class="pc-space-text-button" ?disabled=${p.busy} @click=${p.onCreateChild}>
                  ${icons.plus}${t("createChild")}
                </button>
              </div>`
            : nothing}
        </div>
      </section>`
    : nothing;
}
