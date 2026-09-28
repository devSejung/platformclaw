import { html, nothing } from "lit";
import { icons } from "./icons.ts";

export function compactKnowledgeRevision(revision: string | number) {
  const value = String(revision);
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

/** One document row for Wiki Hub lists and integrated memory search. */
export function renderKnowledgeDocumentCard(options: {
  title: string;
  metadata?: unknown;
  snippet?: string;
  status?: unknown;
  details?: unknown;
  actions?: unknown;
  source?: string;
  disabled?: boolean;
  expanded?: boolean;
  panelId?: string;
  modal?: boolean;
  onOpen?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}) {
  const body = html`<span class="settings-row__text"
      ><span class="settings-row__title">${options.title}</span>${options.snippet
        ? html`<span class="settings-row__desc memory-memories__snippet">${options.snippet}</span>`
        : nothing}${options.metadata ?? nothing}${options.status ?? nothing}</span
    ><span class="settings-row__control"
      ><span class="settings-row__chevron" aria-hidden="true"
        >${options.expanded ? icons.chevronDown : icons.chevronRight}</span
      ></span
    >`;
  return html`<article
    class="memory-memories__result wiki-hub__document-card"
    data-memory-source=${options.source ?? nothing}
    @contextmenu=${options.onContextMenu ?? nothing}
  >
    ${options.onOpen
      ? html`<button
          type="button"
          aria-label=${options.title}
          class="settings-row settings-row--nav"
          ?disabled=${options.disabled}
          aria-haspopup=${options.modal ? "dialog" : nothing}
          aria-expanded=${options.modal
            ? nothing
            : options.expanded === undefined
              ? nothing
              : String(options.expanded)}
          aria-controls=${options.modal ? nothing : (options.panelId ?? nothing)}
          @click=${options.onOpen}
        >
          ${body}
        </button>`
      : html`<div class="settings-row">${body}</div>`}
    ${options.actions ?? nothing}${options.details ?? nothing}
  </article>`;
}
