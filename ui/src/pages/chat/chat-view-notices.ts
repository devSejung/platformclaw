import { html, nothing } from "lit";
import { renderCopyButton } from "../../components/copy-button.ts";
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
  runError?: { summary: string } | null;
  connected: boolean;
  onRefresh?: () => void;
}) {
  if (!props.runError) {
    return nothing;
  }
  const error = props.runError.summary;
  const lines = error
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim());
  const summary = clampText(lines[0] ?? "");
  const hasDetails = lines.some((line) => line !== "" && line !== summary);
  return html`<div class="chat-run-error" role="alert">
    <span class="chat-run-error__icon" aria-hidden="true">${icons.alertTriangle}</span>
    ${hasDetails
      ? html`<details class="chat-run-error__content">
          <summary class="chat-run-error__summary">
            <strong>${summary}</strong><span>${t("chat.errorDetails")}</span>
            ${renderCopyButton(error, t("chat.copyError"))}
          </summary>
          <pre class="chat-run-error__diagnostic" tabindex="0" aria-label=${t("chat.errorDetails")}>
${error}</pre>
        </details>`
      : html`<span class="chat-run-error__content"
          ><span class="chat-run-error__summary">${summary}</span>${renderCopyButton(
            error,
            t("chat.copyError"),
          )}</span
        >`}
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
  </div>`;
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
