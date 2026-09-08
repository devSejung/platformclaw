import "../../components/modal-dialog.ts";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";

export function renderChatResetConfirmation(open: boolean, settle: (confirmed: boolean) => void) {
  if (!open) {
    return nothing;
  }
  const title = t("chat.board.resetTitle");
  const description = t("chat.board.resetDescription");
  return html`
    <openclaw-modal-dialog
      label=${title}
      description=${description}
      @modal-cancel=${() => settle(false)}
    >
      <div class="exec-approval-card board-reset-confirmation">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${title}</div>
            <div class="exec-approval-sub">${description}</div>
          </div>
        </div>
        <div class="exec-approval-actions">
          <button class="btn primary" type="button" @click=${() => settle(true)}>
            ${t("common.confirm")}
          </button>
          <button class="btn" type="button" autofocus @click=${() => settle(false)}>
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
