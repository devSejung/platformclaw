import { html, nothing } from "lit";
import "./modal-dialog.ts";
import "../styles/dreams.css";
import "../styles/knowledge-document.css";

export function renderKnowledgeDocumentReader(options: {
  title: string;
  vaultDocument?: boolean;
  metadata?: unknown;
  actions?: unknown;
  content: unknown;
  closeLabel: string;
  onClose: () => void;
}) {
  return html`<openclaw-modal-dialog
    label=${options.title}
    style="--openclaw-modal-width:1120px"
    @modal-cancel=${options.onClose}
  >
    <div
      class="wiki-hub__preview dreams-diary__preview-panel"
      data-knowledge-document
      data-vault-document=${options.vaultDocument ? "" : nothing}
    >
      <header class="dreams-diary__preview-header wiki-document__header">
        <div class="wiki-document__heading">
          <div class="dreams-diary__preview-title">${options.title}</div>
          <div class="dreams-diary__preview-meta">${options.metadata ?? nothing}</div>
        </div>
        <div class="wiki-document__actions">
          ${options.actions ?? nothing}<button
            class="btn btn--subtle btn--sm"
            @click=${options.onClose}
          >
            ${options.closeLabel}
          </button>
        </div>
      </header>
      <div class="wiki-hub__preview-body dreams-diary__preview-body">${options.content}</div>
    </div></openclaw-modal-dialog
  >`;
}
