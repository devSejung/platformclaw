import "../components/modal-dialog.ts";
import { i18n } from "../i18n/index.ts";
import { notifyPlatformClawExecutionTargetChanged } from "./execution-target-events.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import { PLATFORMCLAW_EXECUTION_API_PATH } from "./web-contract.ts";

type ExecutionTarget = "platform_server" | "assigned_vm";

type ExecutionSettings = {
  activeTarget: ExecutionTarget;
  targetRevision: number;
  credentialStatus: "missing" | "current" | "update_required";
  accountId: string;
  availableVms: Array<{ id: string; label: string }>;
  assignment?: {
    vmHostId: string;
    status: "assigned" | "ready" | "connection_required" | "revoked";
    vmLabel: string;
    safeConnectLabel: string;
    linuxAccount: string;
    remoteWorkspaceDir?: string;
    lastConnectionSucceededAt?: number;
  };
  claudeCode?: {
    executablePath: string;
    reportedVersion: string;
    validatedAt: number;
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

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function localizedRequestError(value: unknown, fallbackKey: string): string {
  if (value === "AD password was not accepted") {
    return t("platformClaw.execution.passwordRejected");
  }
  return typeof value === "string" ? value : t(fallbackKey);
}

class PlatformClawExecutionSettingsElement extends HTMLElement {
  private readonly root = this.attachShadow({ mode: "open" });
  private settings: ExecutionSettings | null = null;
  private opened = false;
  private loading = true;
  private busy = false;
  private message = "";
  private pendingTarget: ExecutionTarget | null = null;
  private pendingRelease = false;
  private unsubscribeLocale = () => {};

  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  onUnauthenticated: () => void = () => {};

  connectedCallback(): void {
    this.unsubscribeLocale = i18n.subscribe(() => void this.renderLocale());
    void this.initialize();
  }

  disconnectedCallback(): void {
    this.unsubscribeLocale();
  }

  private async initialize(): Promise<void> {
    await loadPlatformClawLocale();
    if (!this.isConnected) {
      return;
    }
    this.render();
    await this.refresh();
  }

  private async renderLocale(): Promise<void> {
    await loadPlatformClawLocale();
    if (this.isConnected) {
      this.render();
    }
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
      throw new Error(localizedRequestError(body.error, "platformClaw.execution.requestFailed"));
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
      const previousRevision = this.settings?.targetRevision;
      this.settings = await this.request(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      this.pendingTarget = null;
      this.pendingRelease = false;
      this.message = t("platformClaw.execution.saved");
      if (previousRevision !== undefined && this.settings.targetRevision !== previousRevision) {
        notifyPlatformClawExecutionTargetChanged();
      }
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.execution.requestFailed");
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private bindEvents(): void {
    const closeDialog = () => {
      this.opened = false;
      this.pendingTarget = null;
      this.render();
    };
    this.root.querySelector<HTMLElement>("[data-action='open']")?.addEventListener("click", () => {
      this.opened = true;
      this.render();
    });
    this.root
      .querySelector<HTMLElement>("[data-action='close']")
      ?.addEventListener("click", closeDialog);
    this.root.querySelector("openclaw-modal-dialog")?.addEventListener("modal-cancel", closeDialog);
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
    this.root
      .querySelector<HTMLElement>("[data-action='claude-detect']")
      ?.addEventListener("click", () => {
        if (this.settings) {
          void this.mutate(`${PLATFORMCLAW_EXECUTION_API_PATH}/claude-code`, {
            expectedRevision: this.settings.targetRevision,
          });
        }
      });
    this.root
      .querySelector<HTMLElement>("[data-action='claude-save']")
      ?.addEventListener("click", () => {
        const executablePath =
          this.root.querySelector<HTMLInputElement>("[data-claude-path]")?.value ?? "";
        if (this.settings) {
          void this.mutate(`${PLATFORMCLAW_EXECUTION_API_PATH}/claude-code`, {
            expectedRevision: this.settings.targetRevision,
            executablePath,
          });
        }
      });
    this.root
      .querySelector<HTMLFormElement>("[data-action='select-vm']")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget as HTMLFormElement);
        void this.mutate(`${PLATFORMCLAW_EXECUTION_API_PATH}/selection`, {
          vmHostId: formText(form, "vmHostId"),
          linuxAccount: formText(form, "linuxAccount"),
          password: formText(form, "password"),
        });
      });
    this.root
      .querySelector<HTMLElement>("[data-action='release']")
      ?.addEventListener("click", () => {
        this.pendingRelease = true;
        this.render();
        this.root.querySelector<HTMLElement>("[data-action='confirm-release']")?.focus();
      });
    this.root
      .querySelector<HTMLElement>("[data-action='cancel-release']")
      ?.addEventListener("click", () => {
        this.pendingRelease = false;
        this.render();
        this.root.querySelector<HTMLElement>("[data-action='release']")?.focus();
      });
    this.root
      .querySelector<HTMLElement>("[data-action='confirm-release']")
      ?.addEventListener("click", () => {
        this.pendingRelease = false;
        void this.mutate(`${PLATFORMCLAW_EXECUTION_API_PATH}/release`);
      });
    for (const button of this.root.querySelectorAll<HTMLElement>("[data-target]")) {
      button.addEventListener("click", () => {
        const target = button.dataset.target;
        if (target === "platform_server" || target === "assigned_vm") {
          this.pendingTarget = target;
          this.render();
          this.root.querySelector<HTMLElement>("[data-action='confirm-switch']")?.focus();
        }
      });
    }
    this.root
      .querySelector<HTMLElement>("[data-action='cancel-switch']")
      ?.addEventListener("click", () => {
        const target = this.pendingTarget;
        this.pendingTarget = null;
        this.render();
        this.root.querySelector<HTMLElement>(`[data-target='${target}']`)?.focus();
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
    const vmOptions =
      settings?.availableVms
        .map(
          (vm) =>
            `<option value="${escapeHtml(vm.id)}" ${assignment?.vmHostId === vm.id ? "selected" : ""}>${escapeHtml(vm.label)}</option>`,
        )
        .join("") ?? "";
    this.root.innerHTML = `
      <style>
        :host { display: block; color: var(--text); font: 13px/1.45 var(--font-sans, system-ui, sans-serif); }
        button, input, select { font: inherit; }
        .badge { box-sizing: border-box; display: flex; width: 100%; min-height: 34px; align-items: center; gap: 8px; border: 0; border-radius: var(--radius-md); padding: 7px 9px; background: transparent; color: var(--text); cursor: pointer; text-align: left; transition: background var(--duration-fast) ease; }
        .badge:hover, .badge:focus-visible { background: var(--bg-hover); outline: none; }
        .dot { width: 7px; height: 7px; flex: none; border-radius: var(--radius-full); background: ${assignment?.status === "connection_required" ? "var(--warn)" : "var(--ok)"}; }
        .modal { --openclaw-modal-width: min(520px, calc(100vw - 40px)); --openclaw-modal-max-height: min(720px, calc(100dvh - 40px)); }
        .panel { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; width: min(520px, 100%); max-height: min(720px, calc(100dvh - 40px)); overflow: hidden; border-radius: var(--radius-xl); background: var(--bg-elevated); color: var(--text); box-shadow: var(--shadow-xl); border: 1px solid var(--border); }
        header { display: flex; justify-content: space-between; align-items: center; padding: 20px 22px 12px; }
        h2 { margin: 0; font-size: 20px; } h3 { margin: 0 0 8px; font-size: 14px; }
        .close { border: 0; background: transparent; color: inherit; font-size: 22px; cursor: pointer; }
        main { min-height: 0; overflow: auto; padding: 8px 22px 22px; display: grid; gap: 14px; }
        footer { padding: 14px 22px; border-top: 1px solid var(--border); background: var(--bg-elevated); }
        footer h3, footer p { margin: 0; }
        footer p { margin-top: 6px; }
        footer .row { margin-top: 12px; }
        .card { padding: 15px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); }
        .muted { color: var(--muted); margin: 4px 0; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .button { border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 8px 11px; background: var(--bg-elevated); color: var(--text); cursor: pointer; }
        .button:hover:not(:disabled), .button:focus-visible { border-color: var(--border-hover); background: var(--bg-hover); outline: none; }
        .primary { background: var(--accent); color: var(--accent-foreground); border-color: var(--accent); }
        .primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
        .button:disabled { opacity: .5; cursor: not-allowed; }
        input, select { box-sizing: border-box; width: 100%; padding: 9px 10px; margin: 8px 0; border-radius: var(--radius-md); border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); }
        input:focus, select:focus { border-color: var(--accent); outline: none; box-shadow: var(--focus-ring); }
        .message { padding: 10px 12px; border-radius: var(--radius-md); background: var(--accent-subtle); }
        .confirm { box-shadow: inset 3px 0 0 var(--accent); }
      </style>
      <button class="badge" data-action="open" aria-label="${escapeHtml(t("platformClaw.execution.openSettings"))}"><span class="dot"></span><span>${escapeHtml(badgeLabel)}</span></button>
      ${
        this.opened
          ? `<openclaw-modal-dialog class="modal" label="${escapeHtml(t("platformClaw.execution.workLocation"))}"><section class="panel">
        <header><h2>${escapeHtml(t("platformClaw.execution.workLocation"))}</h2><button class="close" data-action="close" aria-label="${escapeHtml(t("platformClaw.execution.close"))}">×</button></header>
        <main>
          ${this.loading ? `<p>${escapeHtml(t("common.loading"))}</p>` : ""}
          ${this.message ? `<div class="message">${escapeHtml(this.message)}</div>` : ""}
          ${settings ? `<section class="card"><h3>${escapeHtml(t("platformClaw.execution.current"))}</h3><strong>${escapeHtml(badgeLabel)}</strong><p class="muted">${escapeHtml(t("platformClaw.execution.boundary"))}</p><div class="row"><button class="button" data-target="platform_server" ${settings.activeTarget === "platform_server" || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.useBasic"))}</button><button class="button primary" data-target="assigned_vm" ${settings.activeTarget === "assigned_vm" || !canUseVm || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.useVm"))}</button></div></section>` : ""}
          ${assignment ? `<section class="card"><h3>${escapeHtml(t("platformClaw.execution.assignedVm"))}</h3><strong>${escapeHtml(assignment.vmLabel)}</strong><p class="muted">${escapeHtml(assignment.linuxAccount)} · ${escapeHtml(assignment.remoteWorkspaceDir ?? t("platformClaw.execution.workspacePending"))}</p><p class="muted">${escapeHtml(t("platformClaw.execution.lastCheck"))}: ${escapeHtml(formatCheckTime(assignment.lastConnectionSucceededAt))}</p><label>${escapeHtml(t("platformClaw.execution.password"))}<input data-password type="password" autocomplete="current-password" maxlength="4096" /></label><div class="row"><button class="button primary" data-action="credential" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.saveAndTest"))}</button><button class="button" data-action="test" ${settings?.credentialStatus !== "current" || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.test"))}</button><button class="button" data-action="release" ${settings.activeTarget !== "platform_server" || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.release"))}</button></div></section>` : ""}
          ${assignment ? `<section class="card"><h3>${escapeHtml(t("platformClaw.execution.codingAgents"))}</h3><label>${escapeHtml(t("platformClaw.execution.claudePath"))}<input data-claude-path value="${escapeHtml(settings?.claudeCode?.executablePath ?? "")}" placeholder="/home/${escapeHtml(assignment.linuxAccount)}/.local/bin/claude" maxlength="4096" /></label>${settings?.claudeCode ? `<p class="muted">${escapeHtml(settings.claudeCode.reportedVersion)} · ${escapeHtml(formatCheckTime(settings.claudeCode.validatedAt))}</p>` : `<p class="muted">${escapeHtml(t("platformClaw.execution.claudeNotConfigured"))}</p>`}<div class="row"><button class="button" data-action="claude-detect" ${!canUseVm || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.detectClaude"))}</button><button class="button primary" data-action="claude-save" ${!canUseVm || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.saveClaude"))}</button></div></section>` : ""}
          ${settings ? (settings.activeTarget === "platform_server" ? `<section class="card"><h3>${escapeHtml(t("platformClaw.execution.selectVm"))}</h3>${settings.availableVms.length ? `<form data-action="select-vm"><label>${escapeHtml(t("platformClaw.execution.vmChoice"))}<select name="vmHostId" required>${vmOptions}</select></label><label>${escapeHtml(t("platformClaw.execution.linuxAccount"))}<input name="linuxAccount" value="${escapeHtml(assignment?.linuxAccount ?? settings.accountId)}" required></label><label>${escapeHtml(t("platformClaw.execution.password"))}<input name="password" type="password" autocomplete="current-password" maxlength="4096" required></label><p class="muted">${escapeHtml(t("platformClaw.execution.selectionHelp"))}</p><button class="button primary" ${this.busy ? "disabled" : ""}>${escapeHtml(assignment ? t("platformClaw.execution.changeVm") : t("platformClaw.execution.connectVm"))}</button></form>` : `<p class="muted">${escapeHtml(t("platformClaw.execution.noAvailableVm"))}</p>`}</section>` : `<section class="card"><p class="muted">${escapeHtml(t("platformClaw.execution.switchBasicToChange"))}</p></section>`) : ""}
        </main>
        <footer data-confirmation-footer aria-live="polite">
          ${this.pendingTarget ? `<section class="confirm"><h3>${escapeHtml(t("platformClaw.execution.confirmTitle"))}</h3><p>${escapeHtml(t("platformClaw.execution.confirmBody", { target: targetLabel }))}</p><div class="row"><button class="button primary" data-action="confirm-switch" autofocus ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.confirm"))}</button><button class="button" data-action="cancel-switch">${escapeHtml(t("platformClaw.execution.cancel"))}</button></div></section>` : ""}
          ${this.pendingRelease ? `<section class="confirm"><h3>${escapeHtml(t("platformClaw.execution.releaseConfirmTitle"))}</h3><p>${escapeHtml(t("platformClaw.execution.releaseConfirmBody"))}</p><div class="row"><button class="button primary" data-action="confirm-release">${escapeHtml(t("platformClaw.execution.releaseConfirm"))}</button><button class="button" data-action="cancel-release">${escapeHtml(t("platformClaw.execution.cancel"))}</button></div></section>` : ""}
          ${!this.pendingTarget && !this.pendingRelease ? `<button class="button" data-action="refresh" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.refresh"))}</button>` : ""}
        </footer></section></openclaw-modal-dialog>`
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
  const existing = document.querySelector<PlatformClawExecutionSettingsElement>(ELEMENT_NAME);
  const element =
    existing ?? (document.createElement(ELEMENT_NAME) as PlatformClawExecutionSettingsElement);
  element.fetchImpl = options.fetchImpl;
  element.onUnauthenticated = options.onUnauthenticated;
  if (!existing) {
    document.body.append(element);
  }
  return () => {
    if (!existing) {
      element.remove();
    }
  };
}
