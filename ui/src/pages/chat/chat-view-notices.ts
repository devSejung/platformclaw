import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { handleCopyButton } from "../../components/copy-button.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { clampText } from "../../lib/format.ts";
import { renderWorkspaceConflictNotice } from "./components/chat-workspace-conflict.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";

type ChatViewNoticesProps = {
  error?: string | null;
  focusMode?: boolean;
  onDismissError?: () => void;
  onDismissWorkspaceConflict?: () => void;
  onToggleFocusMode?: () => void;
  workspaceConflict?: WorkspaceResultConflict | null;
};

export function renderChatRunErrorNotice(props: {
  runError?: { summary: string; details?: string } | null;
  connected: boolean;
  onRefresh?: () => void;
}) {
  if (!props.runError) {
    return nothing;
  }
  const error = props.runError.summary;
  // Owner-authored support copy includes recovery and partial-action warnings;
  // truncating it like legacy raw errors can hide the instruction to check work.
  const summary = clampText(
    error.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, " ") ?? "",
    props.runError.details ? 500 : 120,
  );
  const report = props.runError.details ?? error;
  const copyLabel = t("chat.copyError");
  const copyReport = async (event: Event) => {
    const notice = (event.currentTarget as HTMLElement).closest(".chat-run-error");
    const copied = await handleCopyButton(event, report, copyLabel);
    const textarea = notice?.querySelector<HTMLTextAreaElement>("textarea");
    if (copied === undefined || !notice?.isConnected || textarea?.value !== report) {
      return;
    }
    const status = notice.querySelector<HTMLElement>("[role='status']");
    if (status) {
      status.textContent = t(copied ? "chat.errorCopied" : "chat.errorCopyFallback");
      status.className = copied ? "agent-chat__sr-only" : "chat-run-error__copy-fallback";
    }
    if (!copied) {
      // Clipboard permission and insecure origins can reject both copy APIs.
      // Reveal a selectable report so the user can still share the same evidence.
      const details = notice.querySelector("details");
      if (details) {
        details.open = true;
      }
      textarea.focus();
      textarea.select();
    }
  };
  return keyed(
    report,
    html`<div class="chat-run-error" role="alert">
      <span class="chat-run-error__icon" aria-hidden="true">${icons.messageSquare}</span>
      <div class="chat-run-error__content">
        <strong class="chat-run-error__summary">${summary}</strong>
        <p class="chat-run-error__help">${t("chat.errorShareHelp")}</p>
        <div class="chat-run-error__actions">
          <button
            class="btn btn--sm chat-copy-btn"
            type="button"
            aria-label=${copyLabel}
            @click=${copyReport}
          >
            <span class="chat-copy-btn__icon" aria-hidden="true">
              <span class="chat-copy-btn__icon-copy">${icons.copy}</span>
              <span class="chat-copy-btn__icon-check">${icons.check}</span>
            </span>
            <span data-copy-label>${copyLabel}</span>
          </button>
          ${props.onRefresh
            ? html`<button
                class="btn btn--sm chat-run-error__refresh"
                type="button"
                ?disabled=${!props.connected}
                @click=${props.onRefresh}
              >
                ${t("common.refresh")}
              </button>`
            : nothing}
        </div>
        <span class="agent-chat__sr-only" role="status" aria-live="polite"></span>
        <details class="chat-run-error__details">
          <summary>${t("chat.errorDetails")}</summary>
          <div class="field chat-run-error__report">
            <textarea
              class="chat-run-error__diagnostic"
              readonly
              rows="6"
              aria-label=${t("chat.errorDetails")}
              .value=${report}
              @focus=${(event: FocusEvent) => (event.target as HTMLTextAreaElement).select()}
            ></textarea>
          </div>
        </details>
      </div>
    </div>`,
  );
}

export function renderChatViewNotices(props: ChatViewNoticesProps) {
  return html`
    ${props.error
      ? html`
          <div class="chat-error" role="alert">
            <span class="chat-error__dot" aria-hidden="true"></span>
            <span class="chat-error__content">${props.error}</span>
            ${props.onDismissError
              ? html`
                  <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
                    <button
                      class="chat-error__dismiss"
                      type="button"
                      @click=${props.onDismissError}
                      aria-label=${t("chat.actions.dismissError")}
                    >
                      ${icons.x}
                    </button>
                  </openclaw-tooltip>
                `
              : nothing}
          </div>
        `
      : nothing}
    ${renderWorkspaceConflictNotice({
      conflict: props.workspaceConflict ?? undefined,
      onDismiss: props.onDismissWorkspaceConflict,
    })}
    ${props.focusMode && props.onToggleFocusMode
      ? html`
          <openclaw-tooltip .content=${t("chat.actions.exitFocusMode")}>
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label=${t("chat.actions.exitFocusMode")}
            >
              ${icons.x}
            </button>
          </openclaw-tooltip>
        `
      : nothing}
  `;
}
