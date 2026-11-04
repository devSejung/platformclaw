import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { icons } from "../components/icons.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import {
  executionLocationStatusStyles,
  renderExecutionLocationStatus,
} from "./execution-location-status.ts";
import type { ExecutionSettings } from "./execution-settings-view.ts";
import {
  subscribeToPlatformClawExecutionSettingsChanges,
  subscribeToPlatformClawExecutionTargetChanges,
} from "./execution-target-events.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import messengerIcon from "./messenger-icon.svg?raw";
import { PLATFORMCLAW_EXECUTION_API_PATH } from "./web-contract.ts";
import "./voc-dialog.ts";

export class PlatformClawQuickActionsElement extends OpenClawLitElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => undefined;
  @property({ type: Boolean }) vocEnabled = false;
  @state() private executionSettingsLoaded = false;
  @state() private executionSettingsSnapshot: ExecutionSettings | undefined;
  @state() private executionLoading = true;
  @state() private vocOpen = false;

  private executionRequest = 0;
  private unsubscribeExecutionTarget = () => {};
  private unsubscribeExecutionSettings = () => {};
  private readonly clearExecutionTarget = () => {
    this.executionSettingsSnapshot = undefined;
  };
  private readonly refreshExecutionTarget = () => {
    this.clearExecutionTarget();
    void this.loadExecutionTarget();
  };
  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.refreshExecutionTarget();
    }
  };

  static override styles = [
    executionLocationStatusStyles,
    css`
      :host {
        display: grid;
        min-width: 0;
        gap: 4px;
      }
      .grid {
        display: grid;
        min-width: 0;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 4px;
      }
      platformclaw-execution-settings,
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
        text-decoration: none;
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
      .split-action {
        justify-content: center;
      }
      .action svg {
        width: 16px;
        height: 16px;
        flex: none;
      }
      .messenger {
        position: relative;
      }
      .messenger--split::before {
        position: absolute;
        top: 9px;
        bottom: 9px;
        left: 0;
        border-left: 1px solid var(--border);
        content: "";
      }
      .label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .span-two {
        grid-column: 1 / -1;
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
    this.unsubscribeExecutionTarget = subscribeToPlatformClawExecutionTargetChanges(
      window,
      this.clearExecutionTarget,
      () => void this.loadExecutionTarget(),
    );
    this.unsubscribeExecutionSettings = subscribeToPlatformClawExecutionSettingsChanges(
      window,
      this.refreshExecutionTarget,
    );
    // Another tab can change the same personal profile without a local Window event.
    window.addEventListener("focus", this.refreshExecutionTarget);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.refreshExecutionTarget();
  }

  override disconnectedCallback(): void {
    this.executionRequest++;
    this.unsubscribeExecutionTarget();
    this.unsubscribeExecutionSettings();
    window.removeEventListener("focus", this.refreshExecutionTarget);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.clearExecutionTarget();
    super.disconnectedCallback();
  }

  private async loadExecutionTarget(): Promise<void> {
    const request = ++this.executionRequest;
    this.executionLoading = true;
    try {
      const response = await this.fetchImpl(PLATFORMCLAW_EXECUTION_API_PATH, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (request !== this.executionRequest || !this.isConnected) {
        return;
      }
      if (response.status === 401) {
        this.onUnauthenticated();
        return;
      }
      if (!response.ok) {
        return;
      }
      const settings = (await response.json()) as ExecutionSettings;
      if (request !== this.executionRequest || !this.isConnected) {
        return;
      }
      if (settings.activeTarget === "platform_server" || settings.activeTarget === "assigned_vm") {
        this.executionSettingsSnapshot = settings;
      }
    } catch {
      // The launcher remains usable; the full view reports actionable errors when opened.
    } finally {
      if (request === this.executionRequest && this.isConnected) {
        this.executionLoading = false;
      }
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
              class="action split-action"
              type="button"
              @click=${() => (this.vocOpen = true)}
              aria-label=${t("platformClaw.quickActions.voc")}
            >
              ${icons.messageSquare}<span class="label">${t("platformClaw.quickActions.voc")}</span>
            </button>`
          : null}
        <a
          class="action messenger ${this.vocEnabled ? "messenger--split split-action" : "span-two"}"
          href="mysingleim://sopa.ai"
          aria-label=${t("platformClaw.quickActions.openMessenger")}
          title=${t("platformClaw.quickActions.messengerHelp")}
        >
          ${unsafeSVG(messengerIcon)}
          <span class="label">${t("platformClaw.quickActions.messenger")}</span>
        </a>
        <button
          class="action span-two"
          type="button"
          data-action="work-location"
          @click=${() => void this.openExecutionSettings()}
          aria-label=${t("platformClaw.execution.openSettings")}
          aria-describedby="execution-location-status"
        >
          ${icons.monitor}<span class="location-launcher-copy"
            ><span class="label">${t("platformClaw.execution.workLocation")}</span
            >${renderExecutionLocationStatus(
              this.executionSettingsSnapshot,
              this.executionLoading,
            )}</span
          >
        </button>
        ${this.executionSettingsLoaded
          ? html`<platformclaw-execution-settings
              class="span-two"
              .fetchImpl=${this.fetchImpl}
              .onUnauthenticated=${this.onUnauthenticated}
              .initialSettings=${this.executionSettingsSnapshot}
              hide-launcher
            ></platformclaw-execution-settings>`
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
