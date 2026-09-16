import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../components/icons.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import "./voc-dialog.ts";

export class PlatformClawQuickActionsElement extends OpenClawLitElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => undefined;
  @property({ type: Boolean }) admin = false;
  @property({ type: Boolean }) vocEnabled = false;
  @state() private executionSettingsLoaded = false;
  @state() private executionTarget: "platform_server" | "assigned_vm" | null = null;
  @state() private vocOpen = false;

  private executionSettingsSnapshot: unknown;

  static override styles = css`
    :host {
      display: grid;
      min-width: 0;
      gap: 4px;
    }
    .grid {
      display: grid;
      min-width: 0;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
      gap: 4px;
    }
    platformclaw-execution-settings,
    platformclaw-vm-administration,
    .action {
      min-width: 0;
    }
    .action {
      box-sizing: border-box;
      display: flex;
      width: 100%;
      min-height: 34px;
      align-items: center;
      gap: 7px;
      overflow: hidden;
      border: 0;
      border-radius: var(--radius-md);
      padding: 7px 9px;
      background: transparent;
      color: var(--muted-strong);
      font: 13px/1.45 var(--font-sans, system-ui, sans-serif);
      text-align: left;
      cursor: pointer;
      transition:
        background var(--duration-fast) ease,
        color var(--duration-fast) ease;
    }
    .action:hover,
    .action:focus-visible {
      background: var(--bg-hover);
      color: var(--text);
      outline: none;
    }
    .action svg {
      width: 16px;
      height: 16px;
      flex: none;
    }
    .execution-dot {
      width: 7px;
      height: 7px;
      flex: none;
      border-radius: var(--radius-full);
      background: var(--ok);
    }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .span-two {
      grid-column: 1 / -1;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
    void this.loadExecutionTarget();
  }

  private async loadExecutionTarget(): Promise<void> {
    try {
      const response = await this.fetchImpl("/platformclaw/api/execution", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        this.onUnauthenticated();
        return;
      }
      if (!response.ok) {
        return;
      }
      const settings = (await response.json()) as { activeTarget?: unknown };
      if (settings.activeTarget === "platform_server" || settings.activeTarget === "assigned_vm") {
        this.executionSettingsSnapshot = settings;
        this.executionTarget = settings.activeTarget;
      }
    } catch {
      // The launcher remains usable; the full view reports actionable errors when opened.
    }
  }

  private async openExecutionSettings(): Promise<void> {
    if (!this.executionSettingsLoaded) {
      await import("./execution-settings.ts");
      if (!this.isConnected) {
        return;
      }
      this.executionSettingsLoaded = true;
      await this.updateComplete;
    }
    this.renderRoot
      .querySelector<HTMLElement & { openSettings: () => void }>("platformclaw-execution-settings")
      ?.openSettings();
  }

  override render() {
    return html`
      <div class="grid" aria-label=${t("platformClaw.quickActions.label")}>
        ${this.vocEnabled
          ? html`<button
              class="action"
              type="button"
              @click=${() => (this.vocOpen = true)}
              aria-label=${t("platformClaw.quickActions.voc")}
            >
              ${icons.messageSquare}<span class="label">${t("platformClaw.quickActions.voc")}</span>
            </button>`
          : null}
        ${this.executionSettingsLoaded
          ? html`<platformclaw-execution-settings
              class=${this.admin ? "" : "span-two"}
              .fetchImpl=${this.fetchImpl}
              .onUnauthenticated=${this.onUnauthenticated}
              .initialSettings=${this.executionSettingsSnapshot}
            ></platformclaw-execution-settings>`
          : html`<button
              class="action ${this.admin ? "" : "span-two"}"
              type="button"
              data-action="work-location"
              @click=${() => void this.openExecutionSettings()}
              aria-label=${t("platformClaw.execution.openSettings")}
            >
              <span class="execution-dot" aria-hidden="true"></span>
              <span class="label"
                >${t(
                  this.executionTarget === "assigned_vm"
                    ? "platformClaw.execution.vm"
                    : this.executionTarget === "platform_server"
                      ? "platformClaw.execution.basic"
                      : "platformClaw.execution.workLocation",
                )}</span
              >
            </button>`}
        ${this.admin
          ? html`<platformclaw-vm-administration
              .fetchImpl=${this.fetchImpl}
              .onUnauthenticated=${this.onUnauthenticated}
            ></platformclaw-vm-administration>`
          : null}
      </div>
      ${this.vocOpen
        ? html`<platformclaw-voc-dialog
            .fetchImpl=${this.fetchImpl}
            .onUnauthenticated=${this.onUnauthenticated}
            @voc-close=${() => (this.vocOpen = false)}
          ></platformclaw-voc-dialog>`
        : null}
    `;
  }
}

if (!customElements.get("platformclaw-quick-actions")) {
  customElements.define("platformclaw-quick-actions", PlatformClawQuickActionsElement);
}
