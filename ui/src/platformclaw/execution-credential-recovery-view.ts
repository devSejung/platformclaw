import { html, nothing } from "lit";
import { icons } from "../components/icons.ts";
import type { ExecutionSettings } from "./execution-settings-view.ts";
import { platformClawT as t } from "./i18n.ts";

export function renderExecutionCredentialRecovery(options: {
  settings: ExecutionSettings | null;
  required: boolean;
  visible: boolean;
  busy: boolean;
  error: string;
  notice: "saved" | "confirmed" | null;
  stateUnavailable: boolean;
  checkingState: boolean;
}) {
  return html`<style>
      :host {
        display: contents;
        font: 13px/1.5 var(--font-sans, system-ui, sans-serif);
        color: var(--text);
      }
      [hidden] {
        display: none !important;
      }
      .button {
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-md);
        padding: 8px 11px;
        background: var(--bg-elevated);
        color: var(--text);
        font: inherit;
        cursor: pointer;
      }
      .button:hover:not(:disabled) {
        background: var(--bg-hover);
      }
      .button:focus-visible {
        outline: none;
        box-shadow: var(--focus-ring);
      }
      .button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .button.primary {
        background: var(--accent);
        color: var(--accent-foreground);
        border-color: var(--accent);
      }
      .recovery-modal {
        --openclaw-modal-width: 440px;
        --openclaw-modal-max-height: calc(100dvh - 32px);
      }
      .recovery-panel {
        display: grid;
        gap: 16px;
        box-sizing: border-box;
        padding: 24px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-xl);
        background: var(--bg-elevated);
        color: var(--text);
        box-shadow: var(--shadow-xl);
      }
      .recovery-panel h2,
      .recovery-panel p {
        margin: 0;
      }
      .recovery-panel h2 {
        font-size: 20px;
        line-height: 1.35;
      }
      .recovery-panel p {
        color: var(--muted);
        line-height: 1.5;
      }
      .recovery-identity {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 10px 12px;
        background: var(--bg);
        border-radius: var(--radius-md);
        overflow-wrap: anywhere;
      }
      .recovery-identity svg {
        width: 18px;
        height: 18px;
        flex: none;
      }
      .recovery-form {
        display: grid;
        gap: 12px;
      }
      .recovery-form label {
        display: grid;
        gap: 7px;
      }
      .recovery-form input {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        padding: 11px 12px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-md);
        background: var(--bg);
        color: var(--text);
        font: 16px var(--font-sans);
      }
      .recovery-form .recovery-error {
        color: var(--danger);
      }
      .recovery-help {
        font-size: 12px;
      }
      .recovery-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .recovery-actions .button {
        min-height: 40px;
      }
      .recovery-banner {
        display: grid;
        gap: 8px;
        padding: 10px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-md);
        color: var(--text);
        background: var(--bg-elevated);
        font-size: 12px;
      }
      .recovery-banner p {
        margin: 0;
      }
      .recovery-banner .button {
        justify-self: start;
      }
      .recovery-success {
        color: var(--ok);
      }
      @media (max-width: 420px) {
        .recovery-panel {
          padding: 20px;
        }
        .recovery-actions {
          flex-direction: column-reverse;
        }
        .recovery-actions .button {
          width: 100%;
        }
      }
    </style>
    ${options.stateUnavailable
      ? html`<section class="recovery-banner" data-recovery-state-error role="status">
          <p>${t("platformClaw.execution.recoveryStateUnavailable")}</p>
          <button
            class="button"
            data-recovery-action="retry"
            ?disabled=${options.busy || options.checkingState}
          >
            ${t("platformClaw.execution.recoveryRetry")}
          </button>
        </section>`
      : nothing}
    ${options.required && !options.visible
      ? html`<section class="recovery-banner" data-recovery-banner role="status">
          <p>${t("platformClaw.execution.recoveryDeferred")}</p>
          <button class="button" data-recovery-action="open">
            ${t("platformClaw.execution.recoveryReconnect")}
          </button>
        </section>`
      : nothing}
    ${options.notice
      ? html`<section class="recovery-banner recovery-success" data-recovery-success role="status">
          <p>
            ${t(
              options.notice === "saved"
                ? "platformClaw.execution.recoverySucceeded"
                : "platformClaw.execution.recoveryConfirmed",
            )}
          </p>
          <button class="button" data-recovery-action="dismiss">
            ${t("platformClaw.execution.close")}
          </button>
        </section>`
      : nothing}
    ${options.visible
      ? html`<openclaw-modal-dialog
          data-recovery-modal
          class="recovery-modal"
          .open=${options.visible}
          .label=${t("platformClaw.execution.recoveryTitle")}
        >
          <section class="recovery-panel" aria-busy=${String(options.busy)}>
            <h2>${t("platformClaw.execution.recoveryTitle")}</h2>
            <p>${t("platformClaw.execution.recoveryDescription")}</p>
            <div class="recovery-identity">
              ${icons.monitor}<span>${options.settings?.assignment?.vmLabel}</span>
            </div>
            <form class="recovery-form" data-recovery-credential>
              <label>
                ${t("platformClaw.execution.password")}
                <input
                  data-recovery-password
                  type="password"
                  name="password"
                  autocomplete="current-password"
                  maxlength="4096"
                  required
                  ?disabled=${options.busy}
                  aria-invalid=${String(Boolean(options.error))}
                  aria-describedby="execution-recovery-help execution-recovery-error"
                />
              </label>
              <p
                class="recovery-error"
                id="execution-recovery-error"
                role="alert"
                ?hidden=${!options.error}
              >
                ${options.error}
              </p>
              <p class="recovery-help" id="execution-recovery-help">
                ${t("platformClaw.execution.recoverySaveHelp")}
              </p>
              <div class="recovery-actions">
                <button
                  type="button"
                  class="button"
                  data-recovery-action="later"
                  ?disabled=${options.busy}
                >
                  ${t("platformClaw.execution.later")}
                </button>
                <button class="button primary" type="submit" ?disabled=${options.busy}>
                  ${t(
                    options.busy
                      ? "platformClaw.execution.recoveryChecking"
                      : "platformClaw.execution.recoverySave",
                  )}
                </button>
              </div>
            </form>
          </section>
        </openclaw-modal-dialog>`
      : nothing}`;
}
