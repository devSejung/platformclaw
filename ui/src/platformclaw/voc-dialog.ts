import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import "../components/modal-dialog.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { platformClawT as t } from "./i18n.ts";
import { PLATFORMCLAW_VOC_API_PATH } from "./web-contract.ts";

type VocResult = { ok: true; issueKey: string; issueUrl: string };

export class PlatformClawVocDialogElement extends OpenClawLitElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => undefined;
  @state() private title = "";
  @state() private description = "";
  @state() private confirming = false;
  @state() private submitting = false;
  @state() private error = "";
  @state() private result: VocResult | null = null;

  static override styles = css`
    :host {
      display: contents;
    }
    .panel {
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      background: var(--bg);
      box-shadow: var(--shadow-xl);
    }
    header,
    footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 18px;
    }
    header {
      border-bottom: 1px solid var(--border);
    }
    footer {
      justify-content: flex-end;
      border-top: 1px solid var(--border);
    }
    h2,
    p {
      margin: 0;
    }
    h2 {
      font-size: 18px;
    }
    header p,
    .hint {
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
    }
    .body {
      display: grid;
      gap: 16px;
      padding: 18px;
    }
    label {
      display: grid;
      gap: 7px;
      color: var(--muted-strong);
      font-size: 13px;
      font-weight: 600;
    }
    textarea {
      min-height: 180px;
      resize: vertical;
    }
    input,
    textarea {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid var(--border-strong, var(--border));
      border-radius: var(--radius-md);
      padding: 10px 12px;
      background: var(--bg-elevated, var(--bg));
      color: var(--text);
      font: 14px/1.5 var(--font-sans, system-ui, sans-serif);
      outline: none;
    }
    input:focus,
    textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
    }
    button {
      min-height: 36px;
      border: 1px solid var(--border-strong, var(--border));
      border-radius: var(--radius-md);
      padding: 7px 14px;
      background: var(--bg-elevated, var(--bg));
      color: var(--text);
      font: 600 13px/1.4 var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
    }
    button:hover:not(:disabled),
    button:focus-visible {
      border-color: var(--accent);
      outline: none;
    }
    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--accent-foreground, white);
    }
    button:disabled {
      cursor: wait;
      opacity: 0.55;
    }
    .close {
      flex: none;
      width: 34px;
      min-height: 34px;
      padding: 0;
      border-color: transparent;
      background: transparent;
      color: var(--muted-strong);
      font-size: 24px;
      font-weight: 400;
    }
    .confirm,
    .success {
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--bg-subtle);
    }
    .error {
      color: var(--danger);
      font-size: 13px;
    }
    .success a {
      color: var(--accent);
      font-weight: 600;
    }
  `;

  private close(): void {
    if (!this.submitting) {
      this.dispatchEvent(new CustomEvent("voc-close", { bubbles: true, composed: true }));
    }
  }

  private async submit(): Promise<void> {
    if (this.submitting || !this.title.trim() || !this.description.trim()) {
      return;
    }
    this.submitting = true;
    this.error = "";
    try {
      const response = await this.fetchImpl(PLATFORMCLAW_VOC_API_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ title: this.title, description: this.description }),
      });
      if (response.status === 401) {
        this.onUnauthenticated();
        throw new Error(t("platformClaw.voc.sessionExpired"));
      }
      const body = (await response.json()) as Partial<VocResult> & { error?: unknown };
      if (!response.ok || body.ok !== true || !body.issueKey || !body.issueUrl) {
        throw new Error(typeof body.error === "string" ? body.error : t("platformClaw.voc.failed"));
      }
      this.result = body as VocResult;
      this.confirming = false;
    } catch (error) {
      this.error = error instanceof Error ? error.message : t("platformClaw.voc.failed");
    } finally {
      this.submitting = false;
    }
  }

  override render() {
    const valid = Boolean(this.title.trim() && this.description.trim());
    return html`
      <openclaw-modal-dialog
        label=${t("platformClaw.voc.title")}
        description=${t("platformClaw.voc.intro")}
        @modal-cancel=${(event: Event) => {
          if (this.submitting) {
            event.preventDefault();
          } else {
            this.close();
          }
        }}
      >
        <section class="panel">
          <header>
            <div>
              <h2>${t("platformClaw.voc.title")}</h2>
              <p>${t("platformClaw.voc.intro")}</p>
            </div>
            <button
              class="close"
              type="button"
              @click=${this.close}
              aria-label=${t("platformClaw.voc.close")}
            >
              ×
            </button>
          </header>
          <div class="body">
            ${this.result
              ? html`<div class="success" role="status">
                  <p>${t("platformClaw.voc.success")}</p>
                  <p class="hint">
                    <a href=${this.result.issueUrl} target="_blank" rel="noopener noreferrer"
                      >${this.result.issueKey}</a
                    >
                  </p>
                </div>`
              : html`
                  <label>
                    ${t("platformClaw.voc.subject")}
                    <input
                      maxlength="200"
                      placeholder=${t("platformClaw.voc.subjectPlaceholder")}
                      autofocus
                      .value=${this.title}
                      ?disabled=${this.submitting}
                      @input=${(event: InputEvent) => {
                        this.title = (event.currentTarget as HTMLInputElement).value;
                        this.confirming = false;
                      }}
                    />
                  </label>
                  <label>
                    ${t("platformClaw.voc.description")}
                    <textarea
                      maxlength="8000"
                      placeholder=${t("platformClaw.voc.descriptionPlaceholder")}
                      .value=${this.description}
                      ?disabled=${this.submitting}
                      @input=${(event: InputEvent) => {
                        this.description = (event.currentTarget as HTMLTextAreaElement).value;
                        this.confirming = false;
                      }}
                    ></textarea>
                  </label>
                  ${this.confirming
                    ? html`<div class="confirm" role="status">
                        <p>${t("platformClaw.voc.confirmBody")}</p>
                      </div>`
                    : null}
                  ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : null}
                `}
          </div>
          <footer>
            ${this.result
              ? html`<button class="primary" type="button" @click=${this.close}>
                  ${t("platformClaw.voc.done")}
                </button>`
              : html`
                  <button type="button" ?disabled=${this.submitting} @click=${this.close}>
                    ${t("platformClaw.voc.cancel")}
                  </button>
                  <button
                    class="primary"
                    type="button"
                    ?disabled=${!valid || this.submitting}
                    @click=${() =>
                      this.confirming ? void this.submit() : (this.confirming = true)}
                  >
                    ${this.submitting
                      ? t("platformClaw.voc.submitting")
                      : this.confirming
                        ? t("platformClaw.voc.confirm")
                        : t("platformClaw.voc.register")}
                  </button>
                `}
          </footer>
        </section>
      </openclaw-modal-dialog>
    `;
  }
}

if (!customElements.get("platformclaw-voc-dialog")) {
  customElements.define("platformclaw-voc-dialog", PlatformClawVocDialogElement);
}
