import { i18n, t } from "../i18n/index.ts";
import { PLATFORMCLAW_EXECUTION_API_PATH } from "./web-contract.ts";

type ExecutionTarget = "platform_server" | "assigned_vm";

type ExecutionSettings = {
  activeTarget: ExecutionTarget;
  targetRevision: number;
  credentialStatus: "missing" | "current" | "update_required";
  assignment?: {
    status: "assigned" | "ready" | "connection_required" | "revoked";
    vmLabel: string;
    safeConnectLabel: string;
    linuxAccount: string;
    remoteWorkspaceDir?: string;
    lastConnectionSucceededAt?: number;
  };
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      default:
        return "&quot;";
    }
  });
}

function formatCheckTime(value?: number): string {
  if (!value) {
    return t("platformClaw.execution.neverChecked");
  }
  const date = new Date(value);
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}

class PlatformClawExecutionSettingsElement extends HTMLElement {
  private readonly root = this.attachShadow({ mode: "open" });
  private settings: ExecutionSettings | null = null;
  private opened = false;
  private loading = true;
  private busy = false;
  private message = "";
  private pendingTarget: ExecutionTarget | null = null;
  private unsubscribeLocale = () => {};

  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  onUnauthenticated: () => void = () => {};

  connectedCallback(): void {
    this.unsubscribeLocale = i18n.subscribe(() => this.render());
    this.render();
    void this.refresh();
  }

  disconnectedCallback(): void {
    this.unsubscribeLocale();
  }

  private async request(path: string, init?: RequestInit): Promise<ExecutionSettings> {
    const response = await this.fetchImpl(path, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...init,
    });
    if (response.status === 401) {
      this.onUnauthenticated();
      throw new Error(t("platformClaw.execution.sessionExpired"));
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        typeof body.error === "string" ? body.error : t("platformClaw.execution.requestFailed"),
      );
    }
    return body as ExecutionSettings;
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      this.settings = await this.request(PLATFORMCLAW_EXECUTION_API_PATH);
      this.message = "";
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.execution.requestFailed");
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async mutate(path: string, body?: unknown): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.message = "";
    this.render();
    try {
      this.settings = await this.request(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      this.pendingTarget = null;
      this.message = t("platformClaw.execution.saved");
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.execution.requestFailed");
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private bindEvents(): void {
    this.root.querySelector<HTMLElement>("[data-action='open']")?.addEventListener("click", () => {
      this.opened = true;
      this.render();
    });
    this.root.querySelector<HTMLElement>("[data-action='close']")?.addEventListener("click", () => {
      this.opened = false;
      this.pendingTarget = null;
      this.render();
    });
    this.root
      .querySelector<HTMLElement>("[data-action='refresh']")
      ?.addEventListener("click", () => void this.refresh());
    this.root
      .querySelector<HTMLElement>("[data-action='test']")
      ?.addEventListener(
        "click",
        () => void this.mutate(`${PLATFORMCLAW_EXECUTION_API_PATH}/test`),
      );
    this.root
      .querySelector<HTMLElement>("[data-action='credential']")
      ?.addEventListener("click", () => {
        const password = this.root.querySelector<HTMLInputElement>("[data-password]")?.value ?? "";
        void this.mutate(`${PLATFORMCLAW_EXECUTION_API_PATH}/credential`, { password });
      });
    for (const button of this.root.querySelectorAll<HTMLElement>("[data-target]")) {
      button.addEventListener("click", () => {
        const target = button.dataset.target;
        if (target === "platform_server" || target === "assigned_vm") {
          this.pendingTarget = target;
          this.render();
        }
      });
    }
    this.root
      .querySelector<HTMLElement>("[data-action='cancel-switch']")
      ?.addEventListener("click", () => {
        this.pendingTarget = null;
        this.render();
      });
    this.root
      .querySelector<HTMLElement>("[data-action='confirm-switch']")
      ?.addEventListener("click", () => {
        if (this.pendingTarget && this.settings) {
          void this.mutate(`${PLATFORMCLAW_EXECUTION_API_PATH}/target`, {
            target: this.pendingTarget,
            expectedRevision: this.settings.targetRevision,
          });
        }
      });
  }

  private render(): void {
    const settings = this.settings;
    const badgeLabel = settings
      ? settings.activeTarget === "assigned_vm"
        ? t("platformClaw.execution.vm")
        : t("platformClaw.execution.basic")
      : t("platformClaw.execution.workLocation");
    const assignment = settings?.assignment;
    const canUseVm = assignment?.status === "ready" && settings?.credentialStatus === "current";
    const targetLabel =
      this.pendingTarget === "assigned_vm"
        ? t("platformClaw.execution.vm")
        : t("platformClaw.execution.basic");
    this.root.innerHTML = `
      <style>
        :host { color-scheme: light dark; font: 13px/1.45 system-ui, sans-serif; }
        button, input { font: inherit; }
        .badge { position: fixed; z-index: 1100; top: 12px; right: 18px; display: flex; align-items: center; gap: 8px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 999px; padding: 7px 12px; background: color-mix(in srgb, Canvas 94%, transparent); color: CanvasText; box-shadow: 0 5px 18px #0002; cursor: pointer; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: ${assignment?.status === "connection_required" ? "#d97706" : "#2f9e66"}; }
        .backdrop { position: fixed; z-index: 1200; inset: 0; background: #0006; display: grid; place-items: center; padding: 20px; }
        .panel { width: min(520px, 100%); max-height: min(720px, 90vh); overflow: auto; border-radius: 18px; background: Canvas; color: CanvasText; box-shadow: 0 24px 70px #0005; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); }
        header { display: flex; justify-content: space-between; align-items: center; padding: 20px 22px 12px; }
        h2 { margin: 0; font-size: 20px; } h3 { margin: 0 0 8px; font-size: 14px; }
        .close { border: 0; background: transparent; color: inherit; font-size: 22px; cursor: pointer; }
        main { padding: 8px 22px 22px; display: grid; gap: 14px; }
        .card { padding: 15px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 12px; background: color-mix(in srgb, CanvasText 3%, Canvas); }
        .muted { color: color-mix(in srgb, currentColor 62%, transparent); margin: 4px 0; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .button { border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 9px; padding: 8px 11px; background: Canvas; color: CanvasText; cursor: pointer; }
        .primary { background: #d9663f; color: white; border-color: #d9663f; }
        .button:disabled { opacity: .5; cursor: not-allowed; }
        input { box-sizing: border-box; width: 100%; padding: 9px 10px; margin: 8px 0; border-radius: 9px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); background: Canvas; color: CanvasText; }
        .message { padding: 10px 12px; border-radius: 9px; background: color-mix(in srgb, #d97706 12%, Canvas); }
        .confirm { border-color: #d9663f; }
      </style>
      <button class="badge" data-action="open" aria-label="${escapeHtml(t("platformClaw.execution.openSettings"))}"><span class="dot"></span><span>${escapeHtml(badgeLabel)}</span></button>
      ${
        this.opened
          ? `<div class="backdrop" role="presentation"><section class="panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("platformClaw.execution.workLocation"))}">
        <header><h2>${escapeHtml(t("platformClaw.execution.workLocation"))}</h2><button class="close" data-action="close" aria-label="${escapeHtml(t("platformClaw.execution.close"))}">×</button></header>
        <main>
          ${this.loading ? `<p>${escapeHtml(t("common.loading"))}</p>` : ""}
          ${this.message ? `<div class="message">${escapeHtml(this.message)}</div>` : ""}
          ${settings ? `<section class="card"><h3>${escapeHtml(t("platformClaw.execution.current"))}</h3><strong>${escapeHtml(badgeLabel)}</strong><p class="muted">${escapeHtml(t("platformClaw.execution.boundary"))}</p><div class="row"><button class="button" data-target="platform_server" ${settings.activeTarget === "platform_server" || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.useBasic"))}</button><button class="button primary" data-target="assigned_vm" ${settings.activeTarget === "assigned_vm" || !canUseVm || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.useVm"))}</button></div></section>` : ""}
          ${assignment ? `<section class="card"><h3>${escapeHtml(t("platformClaw.execution.assignedVm"))}</h3><strong>${escapeHtml(assignment.vmLabel)}</strong><p class="muted">${escapeHtml(assignment.linuxAccount)} · ${escapeHtml(assignment.remoteWorkspaceDir ?? t("platformClaw.execution.workspacePending"))}</p><p class="muted">${escapeHtml(t("platformClaw.execution.lastCheck"))}: ${escapeHtml(formatCheckTime(assignment.lastConnectionSucceededAt))}</p><label>${escapeHtml(t("platformClaw.execution.password"))}<input data-password type="password" autocomplete="current-password" maxlength="4096" /></label><div class="row"><button class="button primary" data-action="credential" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.saveAndTest"))}</button><button class="button" data-action="test" ${settings?.credentialStatus !== "current" || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.test"))}</button></div></section>` : `<section class="card"><h3>${escapeHtml(t("platformClaw.execution.noVm"))}</h3><p class="muted">${escapeHtml(t("platformClaw.execution.noVmHelp"))}</p></section>`}
          ${this.pendingTarget ? `<section class="card confirm"><h3>${escapeHtml(t("platformClaw.execution.confirmTitle"))}</h3><p>${escapeHtml(t("platformClaw.execution.confirmBody", { target: targetLabel }))}</p><div class="row"><button class="button primary" data-action="confirm-switch" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.confirm"))}</button><button class="button" data-action="cancel-switch">${escapeHtml(t("platformClaw.execution.cancel"))}</button></div></section>` : ""}
          <button class="button" data-action="refresh" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.refresh"))}</button>
        </main></section></div>`
          : ""
      }
    `;
    this.bindEvents();
  }
}

const ELEMENT_NAME = "platformclaw-execution-settings";
if (!customElements.get(ELEMENT_NAME)) {
  customElements.define(ELEMENT_NAME, PlatformClawExecutionSettingsElement);
}

export function mountPlatformClawExecutionSettings(options: {
  fetchImpl: typeof fetch;
  onUnauthenticated: () => void;
}): () => void {
  const existing = document.querySelector(ELEMENT_NAME);
  existing?.remove();
  const element = document.createElement(ELEMENT_NAME) as PlatformClawExecutionSettingsElement;
  element.fetchImpl = options.fetchImpl;
  element.onUnauthenticated = options.onUnauthenticated;
  document.body.append(element);
  return () => element.remove();
}
