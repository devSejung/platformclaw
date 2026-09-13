import {
  emptyCodingAgentConfiguration,
  parseCodingAgentConfiguration,
  type CodingAgentConfiguration,
  type CodingAgentId,
  type CodingAgentProbeResult,
  type PersonalCodingAgentSettings,
} from "@platformclaw/coding-agent-contract";
/*
 * Keep the browser form on the same parser as BFF/RPC. A permissive local copy
 * would let URL, quote, or provider-variant behavior drift between boundaries.
 */
import "../components/modal-dialog.ts";
import "../components/web-awesome-tabs.ts";
import { i18n } from "../i18n/index.ts";
import {
  AGENT_LABELS,
  CLAUDE_ENVIRONMENT,
  DEFAULT_EXECUTABLES,
  type ClaudeEnvironmentKey,
  type ExecutionSettings,
  type ExecutionTarget,
  escapeHtml,
  formatCheckTime,
  formText,
  hasLiteralSurroundingQuotes,
  localizedRequestError,
} from "./execution-settings-view.ts";
import { notifyPlatformClawExecutionTargetChanged } from "./execution-target-events.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import { PLATFORMCLAW_EXECUTION_API_PATH } from "./web-contract.ts";

const AGENTS: CodingAgentId[] = ["claude", "codex", "opencode"];

class PlatformClawExecutionSettingsElement extends HTMLElement {
  private readonly root = this.attachShadow({ mode: "open" });
  private settings: ExecutionSettings | null = null;
  private opened = false;
  private loading = true;
  private busy = false;
  private busyAgentAction: { agent: CodingAgentId; action: "detect" | "check" | "save" } | null =
    null;
  private message = "";
  private messageKind: "info" | "error" = "info";
  private pendingTarget: ExecutionTarget | null = null;
  private pendingRelease = false;
  private activeTab: "location" | "agents" = "location";
  private readonly expandedAgents = new Set<CodingAgentId>();
  private readonly codingAgentDrafts = new Map<CodingAgentId, CodingAgentConfiguration>();
  private readonly codingAgentDirtyFields = new Map<CodingAgentId, Set<string>>();
  private readonly codingAgentManualFields = new Map<CodingAgentId, Set<string>>();
  private readonly codingAgentProbes = new Map<CodingAgentId, CodingAgentProbeResult>();
  private readonly codingAgentProbeKinds = new Map<CodingAgentId, "detect" | "check">();
  private readonly codingAgentProbeTimes = new Map<CodingAgentId, number>();
  private readonly codingAgentErrors = new Map<CodingAgentId, Record<string, string>>();
  private gatewayExpanded = false;
  private unsubscribeLocale = () => {};

  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  onUnauthenticated: () => void = () => {};
  initialSettings?: ExecutionSettings;

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
    if (this.initialSettings) {
      this.settings = this.initialSettings;
      this.syncCodingAgentDrafts(this.initialSettings);
      this.loading = false;
      this.render();
      return;
    }
    this.render();
    await this.refresh();
  }
  openSettings(): void {
    this.opened = true;
    this.render();
  }
  private async renderLocale(): Promise<void> {
    await loadPlatformClawLocale();
    if (this.isConnected) {
      this.render();
    }
  }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
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
    return body as T;
  }
  private syncCodingAgentDrafts(settings: ExecutionSettings, force = false): void {
    for (const agent of AGENTS) {
      const saved =
        settings.codingAgents?.find((item) => item.configuration.agent === agent)?.configuration ??
        emptyCodingAgentConfiguration(agent);
      if (force || !this.codingAgentDirtyFields.get(agent)?.size) {
        this.codingAgentDrafts.set(agent, structuredClone(saved));
      }
    }
  }
  private assignmentIdentity(settings: ExecutionSettings | null): string {
    return settings?.assignment?.id ?? "";
  }
  private resetCodingAgentDraftState(): void {
    this.codingAgentDrafts.clear();
    this.codingAgentDirtyFields.clear();
    this.codingAgentManualFields.clear();
    this.codingAgentProbes.clear();
    this.codingAgentProbeKinds.clear();
    this.codingAgentProbeTimes.clear();
    this.codingAgentErrors.clear();
  }
  private async refresh(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const previousAssignment = this.assignmentIdentity(this.settings);
      const settings = await this.request<ExecutionSettings>(PLATFORMCLAW_EXECUTION_API_PATH);
      if (previousAssignment && previousAssignment !== this.assignmentIdentity(settings)) {
        this.resetCodingAgentDraftState();
      }
      this.settings = settings;
      this.syncCodingAgentDrafts(settings);
      this.message = "";
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.execution.requestFailed");
      this.messageKind = "error";
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
      const previousAssignment = this.assignmentIdentity(this.settings);
      this.settings = await this.request<ExecutionSettings>(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (previousAssignment !== this.assignmentIdentity(this.settings)) {
        this.resetCodingAgentDraftState();
        this.syncCodingAgentDrafts(this.settings, true);
      } else {
        this.syncCodingAgentDrafts(this.settings);
      }
      this.pendingTarget = null;
      this.pendingRelease = false;
      this.message = t("platformClaw.execution.saved");
      this.messageKind = "info";
      if (previousRevision !== undefined && this.settings.targetRevision !== previousRevision) {
        notifyPlatformClawExecutionTargetChanged();
      }
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.execution.requestFailed");
      this.messageKind = "error";
    } finally {
      this.busy = false;
      this.render();
    }
  }
  private configuration(agent: CodingAgentId): CodingAgentConfiguration {
    return this.codingAgentDrafts.get(agent) ?? emptyCodingAgentConfiguration(agent);
  }
  private validateCodingAgent(agent: CodingAgentId, action: "check" | "save"): boolean {
    const configuration = this.configuration(agent);
    const errors: Record<string, string> = {};
    const validate = (field: string, label: string, value: string, required: boolean) => {
      if (required && !value.trim()) {
        errors[field] = t("platformClaw.execution.agentFieldRequired", { field: label });
      } else if (hasLiteralSurroundingQuotes(value)) {
        errors[field] = t("platformClaw.execution.agentFieldQuoted", { field: label });
      }
    };
    validate(
      "executablePath",
      `${AGENT_LABELS[agent]} executable`,
      configuration.executablePath,
      action === "check" || configuration.enabled,
    );
    if (configuration.agent === "claude") {
      for (const field of CLAUDE_ENVIRONMENT) {
        validate(
          field.key,
          t(field.labelKey),
          configuration.environment[field.key],
          action === "check" || configuration.enabled,
        );
      }
    }
    if (!Object.keys(errors).length) {
      try {
        parseCodingAgentConfiguration(configuration);
      } catch (error) {
        errors.configuration =
          error instanceof Error
            ? error.message
            : t("platformClaw.execution.agentConfigurationInvalid");
      }
    }
    this.codingAgentErrors.set(agent, errors);
    if (!Object.keys(errors).length) {
      return true;
    }
    this.message = t("platformClaw.execution.agentReviewFields", {
      agent: AGENT_LABELS[agent],
    });
    this.messageKind = "error";
    this.gatewayExpanded ||= agent === "claude";
    this.render();
    return false;
  }
  private async codingAgentRequest(
    action: "detect" | "check" | "save",
    agent: CodingAgentId,
  ): Promise<void> {
    if (
      this.busy ||
      !this.settings ||
      (action !== "detect" && !this.validateCodingAgent(agent, action))
    ) {
      return;
    }
    this.busy = true;
    this.busyAgentAction = { agent, action };
    this.message = "";
    this.messageKind = "info";
    this.render();
    try {
      const configuration = this.configuration(agent);
      const body =
        action === "detect"
          ? { action, agent, expectedRevision: this.settings.targetRevision }
          : { action, configuration, expectedRevision: this.settings.targetRevision };
      const result = await this.request<CodingAgentProbeResult | ExecutionSettings>(
        `${PLATFORMCLAW_EXECUTION_API_PATH}/coding-agent`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      if (action === "save") {
        const previousRevision = this.settings.targetRevision;
        this.settings = result as ExecutionSettings;
        this.codingAgentDirtyFields.delete(agent);
        this.codingAgentManualFields.delete(agent);
        this.codingAgentErrors.delete(agent);
        const saved = this.settings.codingAgents.find((item) => item.configuration.agent === agent);
        this.codingAgentDrafts.set(
          agent,
          structuredClone(saved?.configuration ?? emptyCodingAgentConfiguration(agent)),
        );
        this.message = t("platformClaw.execution.agentSaved", { agent: AGENT_LABELS[agent] });
        if (this.settings.targetRevision !== previousRevision) {
          notifyPlatformClawExecutionTargetChanged();
        }
      } else {
        const probe = result as CodingAgentProbeResult;
        this.codingAgentProbes.set(agent, probe);
        this.codingAgentProbeKinds.set(agent, action);
        if (action === "check") {
          this.codingAgentProbeTimes.set(agent, Date.now());
        }
        if (action === "detect") {
          this.applyDetection(agent, probe);
          this.message = t("platformClaw.execution.agentDetected", {
            agent: AGENT_LABELS[agent],
          });
        } else {
          this.message = t("platformClaw.execution.agentCheckFinished", {
            agent: AGENT_LABELS[agent],
          });
        }
      }
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.execution.requestFailed");
      this.messageKind = "error";
    } finally {
      this.busy = false;
      this.busyAgentAction = null;
      this.render();
    }
  }
  private applyDetection(agent: CodingAgentId, probe: CodingAgentProbeResult): void {
    const current = structuredClone(this.configuration(agent));
    const dirty = this.codingAgentDirtyFields.get(agent) ?? new Set<string>();
    const manual = this.codingAgentManualFields.get(agent) ?? new Set<string>();
    const errors = this.codingAgentErrors.get(agent);
    if (probe.executablePath && !manual.has("executablePath")) {
      current.executablePath = probe.executablePath;
      dirty.add("executablePath");
      delete errors?.executablePath;
    }
    if (agent === "claude" && current.agent === "claude" && probe.environment) {
      for (const { key } of CLAUDE_ENVIRONMENT) {
        if (!manual.has(key) && probe.environment[key]) {
          current.environment[key] = probe.environment[key];
          dirty.add(key);
          delete errors?.[key];
        }
      }
      this.gatewayExpanded = true;
    }
    this.codingAgentDrafts.set(agent, current);
    this.codingAgentDirtyFields.set(agent, dirty);
    if (errors) {
      delete errors.configuration;
      if (!Object.keys(errors).length) {
        this.codingAgentErrors.delete(agent);
      }
    }
  }
  private updateDraft(agent: CodingAgentId, field: string, value: string | boolean): void {
    const configuration = structuredClone(this.configuration(agent));
    if (field === "enabled") {
      configuration.enabled = Boolean(value);
    } else if (field === "executablePath") {
      configuration.executablePath = String(value);
    } else if (configuration.agent === "claude") {
      configuration.environment[field as ClaudeEnvironmentKey] = String(value);
    }
    this.codingAgentDrafts.set(agent, configuration);
    const dirty = this.codingAgentDirtyFields.get(agent) ?? new Set<string>();
    dirty.add(field);
    this.codingAgentDirtyFields.set(agent, dirty);
    const manual = this.codingAgentManualFields.get(agent) ?? new Set<string>();
    manual.add(field);
    this.codingAgentManualFields.set(agent, manual);
    if (field !== "enabled") {
      this.codingAgentProbes.delete(agent);
      this.codingAgentProbeKinds.delete(agent);
      this.codingAgentProbeTimes.delete(agent);
    }
    const errors = this.codingAgentErrors.get(agent);
    delete errors?.configuration;
    if (errors?.[field]) {
      delete errors[field];
      this.root.querySelector(`[data-error-for='${agent}-${field}']`)?.replaceChildren();
      this.root
        .querySelector(`[data-agent-field='${agent}-${field}']`)
        ?.removeAttribute("aria-invalid");
    }
    if (errors && !Object.keys(errors).length) {
      this.codingAgentErrors.delete(agent);
      if (this.messageKind === "error") {
        this.message = "";
        this.root.querySelector(".message--error")?.remove();
      }
    }
  }
  private codingAgentSummary(agent: CodingAgentId): string {
    const saved = this.settings?.codingAgents.find((item) => item.configuration.agent === agent);
    if (!saved?.lastCheck) {
      return t("platformClaw.execution.agentSummaryNotChecked");
    }
    if (saved.lastCheck.diagnostics.some((diagnostic) => diagnostic.status === "failed")) {
      return t("platformClaw.execution.agentSummaryAttention");
    }
    const acp = saved.lastCheck.diagnostics.find((diagnostic) => diagnostic.stage === "acp");
    if (acp?.status === "passed") {
      return t("platformClaw.execution.agentSummaryReady");
    }
    const executable = saved.lastCheck.diagnostics.find(
      (diagnostic) => diagnostic.stage === "executable",
    );
    return executable?.status === "passed"
      ? t("platformClaw.execution.agentSummaryInstalled")
      : t("platformClaw.execution.agentSummaryNotChecked");
  }
  private renderTabs(): string {
    return `<wa-tab-group class="settings-tabs" aria-label="${escapeHtml(t("platformClaw.execution.settingsSections"))}" active="${this.activeTab}" activation="manual" without-scroll-controls>${(
      ["location", "agents"] as const
    )
      .map((id) => {
        const selected = this.activeTab === id;
        return `<wa-tab id="execution-tab-${id}" slot="nav" panel="${id}" data-settings-tab="${id}" ${selected ? "active" : ""}>${escapeHtml(t(id === "location" ? "platformClaw.execution.locationTab" : "platformClaw.execution.agentsTab"))}</wa-tab>`;
      })
      .join("")}</wa-tab-group>`;
  }

  private renderCredentialSection(): string {
    const open = !(
      this.settings?.assignment?.status === "ready" && this.settings.credentialStatus === "current"
    );
    return `<details class="credentials-details" ${open ? "open" : ""}><summary>${escapeHtml(t("platformClaw.execution.changeCredentials"))}</summary><label>${escapeHtml(t("platformClaw.execution.password"))}<input data-password type="password" autocomplete="current-password" maxlength="4096" ${this.busy ? "disabled" : ""}></label><div class="row"><button class="button primary" data-action="credential" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.saveAndTest"))}</button></div></details>`;
  }

  private renderLocationPanel(settings: ExecutionSettings): string {
    const assignment = settings.assignment;
    const canUseVm = assignment?.status === "ready" && settings.credentialStatus === "current";
    const vmOptions = settings.availableVms
      .map(
        (vm) =>
          `<option value="${escapeHtml(vm.id)}" ${assignment?.vmHostId === vm.id ? "selected" : ""}>${escapeHtml(vm.label)}</option>`,
      )
      .join("");
    const badgeLabel =
      settings.activeTarget === "assigned_vm"
        ? t("platformClaw.execution.vm")
        : t("platformClaw.execution.basic");
    const targetActions = `<div class="row">${settings.activeTarget === "platform_server" ? `<span class="current-pill">${escapeHtml(t("platformClaw.execution.currentlyActive"))}</span>` : `<button class="button" data-target="platform_server" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.useBasic"))}</button>`}${settings.activeTarget === "assigned_vm" ? `<span class="current-pill">${escapeHtml(t("platformClaw.execution.currentlyActive"))}</span>` : `<button class="button primary" data-target="assigned_vm" ${!canUseVm || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.useVm"))}</button>`}</div>`;
    const assignmentCard = assignment
      ? `<section class="card"><h3>${escapeHtml(t("platformClaw.execution.assignedVm"))}</h3><strong>${escapeHtml(assignment.vmLabel)}</strong><p class="muted">${escapeHtml(assignment.linuxAccount)} · ${escapeHtml(assignment.remoteWorkspaceDir ?? t("platformClaw.execution.workspacePending"))}</p><p class="muted">${escapeHtml(t("platformClaw.execution.lastCheck"))}: ${escapeHtml(formatCheckTime(assignment.lastConnectionSucceededAt))}</p><div class="row vm-actions"><button class="button" data-action="test" ${settings.credentialStatus !== "current" || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.test"))}</button><button class="button" data-action="release" ${settings.activeTarget !== "platform_server" || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.release"))}</button></div>${this.renderCredentialSection()}</section>`
      : "";
    const selection =
      settings.activeTarget === "platform_server"
        ? `<section class="card"><h3>${escapeHtml(t("platformClaw.execution.selectVm"))}</h3>${settings.availableVms.length ? `<form data-action="select-vm"><label>${escapeHtml(t("platformClaw.execution.vmChoice"))}<select name="vmHostId" required ${this.busy ? "disabled" : ""}>${vmOptions}</select></label><label>${escapeHtml(t("platformClaw.execution.linuxAccount"))}<input name="linuxAccount" value="${escapeHtml(assignment?.linuxAccount ?? settings.accountId)}" required ${this.busy ? "disabled" : ""}></label><label>${escapeHtml(t("platformClaw.execution.password"))}<input name="password" type="password" autocomplete="current-password" maxlength="4096" required ${this.busy ? "disabled" : ""}></label><p class="muted">${escapeHtml(t("platformClaw.execution.selectionHelp"))}</p><button class="button primary" ${this.busy ? "disabled" : ""}>${escapeHtml(assignment ? t("platformClaw.execution.changeVm") : t("platformClaw.execution.connectVm"))}</button></form>` : `<p class="muted">${escapeHtml(t("platformClaw.execution.noAvailableVm"))}</p>`}</section>`
        : `<section class="card"><p class="muted">${escapeHtml(t("platformClaw.execution.switchBasicToChange"))}</p></section>`;
    return `<section class="tab-panel" id="execution-panel-location" role="tabpanel" aria-labelledby="execution-tab-location"><section class="card"><h3>${escapeHtml(t("platformClaw.execution.current"))}</h3><strong>${escapeHtml(badgeLabel)}</strong><p class="muted">${escapeHtml(t("platformClaw.execution.boundary"))}</p>${targetActions}</section>${assignmentCard}${selection}</section>`;
  }

  private renderAgentsPanel(settings: ExecutionSettings): string {
    const assignment = settings.assignment;
    return `<section class="tab-panel coding-agents" id="execution-panel-agents" role="tabpanel" aria-labelledby="execution-tab-agents">${assignment ? `<p class="agent-context">${escapeHtml(assignment.vmLabel)} · ${escapeHtml(assignment.linuxAccount)}</p><p class="agent-shared-help">${escapeHtml(t("platformClaw.execution.agentOffHelp"))}</p>${AGENTS.map((agent) => this.renderCodingAgent(agent)).join("")}` : `<p class="muted">${escapeHtml(t("platformClaw.execution.noAvailableVm"))}</p>`}</section>`;
  }
  private bindEvents(): void {
    const closeDialog = () => {
      this.opened = false;
      this.pendingTarget = null;
      this.pendingRelease = false;
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
    for (const tab of this.root.querySelectorAll<HTMLElement>("[data-settings-tab]")) {
      tab.addEventListener("click", () => {
        this.activeTab = tab.dataset.settingsTab === "agents" ? "agents" : "location";
        this.render();
      });
    }
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
    for (const agent of AGENTS) {
      this.root
        .querySelector<HTMLInputElement>(`[data-agent-toggle='${agent}']`)
        ?.addEventListener("change", (event) => {
          const enabled = (event.currentTarget as HTMLInputElement).checked;
          this.updateDraft(agent, "enabled", enabled);
          const valid = !enabled || this.validateCodingAgent(agent, "save");
          if (!valid) {
            this.expandedAgents.add(agent);
          }
          this.render();
        });
      for (const input of this.root.querySelectorAll<HTMLInputElement>(
        `[data-agent-field^='${agent}-']`,
      )) {
        input.addEventListener("input", () =>
          this.updateDraft(agent, input.dataset.field ?? "", input.value),
        );
      }
      for (const action of ["detect", "check", "save"] as const) {
        this.root
          .querySelector<HTMLElement>(`[data-agent-action='${agent}-${action}']`)
          ?.addEventListener("click", () => void this.codingAgentRequest(action, agent));
      }
      this.root
        .querySelector<HTMLElement>(`[data-agent-quick-save='${agent}']`)
        ?.addEventListener("click", () => void this.codingAgentRequest("save", agent));
      this.root
        .querySelector<HTMLElement>(`[data-agent-expand='${agent}']`)
        ?.addEventListener("click", () => {
          if (this.expandedAgents.has(agent)) {
            this.expandedAgents.delete(agent);
          } else {
            this.expandedAgents.add(agent);
          }
          this.render();
        });
    }
    this.root
      .querySelector<HTMLDetailsElement>("[data-claude-gateway]")
      ?.addEventListener("toggle", (event) => {
        this.gatewayExpanded = (event.currentTarget as HTMLDetailsElement).open;
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
        this.pendingTarget = null;
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
          this.pendingRelease = false;
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
  private renderField(
    agent: CodingAgentId,
    field: string,
    label: string,
    value: string,
    secondary?: string,
  ): string {
    const error = this.codingAgentErrors.get(agent)?.[field];
    const errorId = `${agent}-${field}-error`;
    return `<label class="field"><span>${escapeHtml(label)}</span>${secondary ? `<small>${escapeHtml(secondary)}</small>` : ""}<input data-agent-field="${agent}-${field}" data-field="${field}" value="${escapeHtml(value)}" placeholder="${escapeHtml(field === "executablePath" ? DEFAULT_EXECUTABLES[agent] : t("platformClaw.execution.agentEnterValue"))}" autocomplete="off" spellcheck="false" ${error ? `aria-invalid="true" aria-describedby="${errorId}"` : ""} maxlength="4096" ${this.busy ? "disabled" : ""}><span class="field-error" id="${errorId}" data-error-for="${agent}-${field}">${error ? escapeHtml(error) : ""}</span></label>`;
  }
  private renderDiagnostics(agent: CodingAgentId, settings?: PersonalCodingAgentSettings): string {
    const needsRecheck = [...(this.codingAgentDirtyFields.get(agent) ?? [])].some(
      (field) => field !== "enabled",
    );
    const result = this.codingAgentProbes.get(agent) ?? settings?.lastCheck;
    if (!result) {
      return `<p class="status-copy muted">${escapeHtml(t("platformClaw.execution.agentNotChecked"))}</p>`;
    }
    const diagnostics = result.diagnostics
      .map(
        (diagnostic) =>
          `<li class="diagnostic diagnostic--${diagnostic.status}"><span aria-hidden="true">${diagnostic.status === "passed" ? "✓" : diagnostic.status === "failed" ? "!" : "–"}</span><span><strong>${escapeHtml(t(diagnostic.stage === "executable" ? "platformClaw.execution.agentStageInstalled" : diagnostic.stage === "helper" ? "platformClaw.execution.agentStageAuthentication" : "platformClaw.execution.agentStageAcpConnection"))}</strong><small>${escapeHtml(diagnostic.message)}</small></span></li>`,
      )
      .join("");
    const preview = this.codingAgentProbeKinds.get(agent) === "detect";
    const checkedAt =
      "checkedAt" in result ? result.checkedAt : this.codingAgentProbeTimes.get(agent);
    return `<div class="agent-status">${preview ? `<p class="stale-status">${escapeHtml(t("platformClaw.execution.agentDetectedPreview"))}</p>` : ""}${needsRecheck ? `<p class="stale-status">${escapeHtml(t("platformClaw.execution.agentNeedsRecheck"))}</p>` : ""}<ul class="${needsRecheck ? "is-stale" : ""}">${diagnostics}</ul>${result.reportedVersion ? `<p class="version">${escapeHtml(result.reportedVersion)}${checkedAt ? ` · ${escapeHtml(formatCheckTime(checkedAt))}` : ""}</p>` : ""}</div>`;
  }
  private renderCodingAgent(agent: CodingAgentId): string {
    const configuration = this.configuration(agent);
    const saved = this.settings?.codingAgents?.find((item) => item.configuration.agent === agent);
    const canProbe =
      this.settings?.assignment?.status === "ready" && this.settings.credentialStatus === "current";
    const canEditConfig = Boolean(
      this.settings?.assignment && this.settings.assignment.status !== "revoked",
    );
    const dirty = Boolean(this.codingAgentDirtyFields.get(agent)?.size);
    const gatewayComplete =
      configuration.agent === "claude" &&
      CLAUDE_ENVIRONMENT.every(({ key }) => configuration.environment[key].trim());
    const gateway =
      configuration.agent === "claude"
        ? `<details class="gateway" data-claude-gateway ${this.gatewayExpanded || !gatewayComplete ? "open" : ""}><summary><span><strong>${escapeHtml(t("platformClaw.execution.claudeGateway"))}</strong><small>${escapeHtml(t(gatewayComplete ? "platformClaw.execution.claudeGatewayConfigured" : "platformClaw.execution.claudeGatewaySetup"))}</small></span><span class="chevron" aria-hidden="true">⌄</span></summary><div class="gateway-fields"><p class="field-help">${escapeHtml(t("platformClaw.execution.claudeGatewayLiteralHelp"))}</p>${CLAUDE_ENVIRONMENT.map(({ key, labelKey }) => this.renderField(agent, key, t(labelKey), configuration.environment[key], key)).join("")}</div></details>`
        : "";
    const configurationError = this.codingAgentErrors.get(agent)?.configuration;
    const savedEnabled = saved?.configuration.enabled ?? false;
    const expanded = this.expandedAgents.has(agent);
    const progress =
      this.busyAgentAction?.agent === agent
        ? `<p class="agent-progress" role="status" aria-live="polite">${escapeHtml(t(this.busyAgentAction.action === "check" ? "platformClaw.execution.agentChecking" : this.busyAgentAction.action === "detect" ? "platformClaw.execution.agentDetecting" : "platformClaw.execution.agentSaving"))}</p>`
        : "";
    return `<section class="agent-card${expanded ? "" : " is-collapsed"}" data-coding-agent="${agent}" ${this.busyAgentAction?.agent === agent ? `aria-busy="true"` : ""}><div class="agent-heading"><div><h3>${AGENT_LABELS[agent]}</h3><p>${escapeHtml(savedEnabled ? t("platformClaw.execution.agentSavedOn") : t("platformClaw.execution.agentSavedOff"))}</p>${dirty ? `<p class="unsaved">${escapeHtml(t("platformClaw.execution.agentUnsaved"))}</p>` : ""}<p class="compact-check">${escapeHtml(this.codingAgentSummary(agent))}</p>${dirty && !expanded ? `<button class="button agent-quick-save" data-agent-quick-save="${agent}" ${!canEditConfig || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.agentSaveChanges"))}</button>` : ""}</div><button class="agent-expand" data-agent-expand="${agent}" type="button" aria-expanded="${expanded}" aria-controls="agent-settings-${agent}">${escapeHtml(t(expanded ? "platformClaw.execution.agentCollapse" : "platformClaw.execution.agentConfigure"))}</button><label class="switch"><input type="checkbox" role="switch" aria-label="${escapeHtml(t("platformClaw.execution.useAgent", { agent: AGENT_LABELS[agent] }))}" data-agent-toggle="${agent}" ${configuration.enabled ? "checked" : ""} ${!canEditConfig || this.busy ? "disabled" : ""}><span aria-hidden="true"></span><b>${escapeHtml(t("platformClaw.execution.agentToggleShort"))}</b></label></div><div class="agent-settings" id="agent-settings-${agent}">${progress}${this.renderDiagnostics(agent, saved)}${this.renderField(agent, "executablePath", t("platformClaw.execution.agentExecutable"), configuration.executablePath, t("platformClaw.execution.agentAbsolutePath"))}${gateway}${configurationError ? `<p class="configuration-error" role="alert">${escapeHtml(configurationError)}</p>` : ""}<p class="check-note">${escapeHtml(t("platformClaw.execution.agentCheckTokens"))}</p><div class="agent-actions"><button class="button" data-agent-action="${agent}-detect" ${!canProbe || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.agentDetect"))}</button><button class="button" data-agent-action="${agent}-check" ${!canProbe || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.agentCheck"))}</button><button class="button primary" data-agent-action="${agent}-save" ${!canEditConfig || this.busy ? "disabled" : ""}>${escapeHtml(dirty ? t("platformClaw.execution.agentSaveChanges") : t("platformClaw.execution.agentSave"))}</button></div></div></section>`;
  }
  private render(): void {
    const settings = this.settings;
    const badgeLabel = settings
      ? settings.activeTarget === "assigned_vm"
        ? t("platformClaw.execution.vm")
        : t("platformClaw.execution.basic")
      : t("platformClaw.execution.workLocation");
    const assignment = settings?.assignment;
    const targetLabel =
      this.pendingTarget === "assigned_vm"
        ? t("platformClaw.execution.vm")
        : t("platformClaw.execution.basic");
    this.root.innerHTML = `<style>
      [hidden]{display:none!important}
      .panel{grid-template-rows:auto auto minmax(0,1fr) auto!important}.agent-card .disable-note{display:none}
      .settings-tabs{display:block;padding:0 22px 10px;border-bottom:1px solid var(--border)}.settings-tabs wa-tab{flex:1;border-radius:var(--radius-md)}.tab-panel{display:grid;gap:14px}.current-pill{display:inline-flex;padding:7px 10px;border-radius:var(--radius-md);background:var(--accent-subtle);color:var(--accent);font-weight:700}.credentials-details{margin-top:10px;border-top:1px solid var(--border);padding-top:9px}.credentials-details summary{cursor:pointer;font-weight:700}.credentials-details[open] summary{margin-bottom:8px}.agent-context,.agent-shared-help{margin:0;color:var(--muted)}.agent-context{font-weight:700;color:var(--text)}.agent-card.is-collapsed>.agent-settings{display:none}.agent-settings{display:grid;gap:12px}.compact-check{margin-top:4px!important}.agent-quick-save{margin-top:7px;padding:5px 8px;font-size:12px}.agent-progress{margin:0;padding:8px 10px;border-radius:var(--radius-md);background:var(--accent-subtle);font-weight:700}.agent-expand{border:0;background:transparent;color:var(--accent);padding:5px;cursor:pointer}.agent-expand:focus-visible{outline:none;box-shadow:var(--focus-ring)}
      .agent-status ul.is-stale{opacity:.5}.stale-status,.unsaved{margin:0 0 6px;color:var(--warn);font-size:12px}
      :host{display:block;color:var(--text);font:13px/1.45 var(--font-sans,system-ui,sans-serif)}button,input,select{font:inherit}*{box-sizing:border-box}.badge{display:flex;width:100%;min-height:34px;align-items:center;gap:8px;border:0;border-radius:var(--radius-md);padding:7px 9px;background:transparent;color:var(--text);cursor:pointer;text-align:left}.badge:hover,.badge:focus-visible{background:var(--bg-hover);outline:none}.dot{width:7px;height:7px;flex:none;border-radius:var(--radius-full);background:${assignment?.status === "connection_required" ? "var(--warn)" : "var(--ok)"}}
      .modal{--openclaw-modal-width:min(680px,calc(100vw - 32px));--openclaw-modal-max-height:min(820px,calc(100dvh - 24px))}.panel{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:min(680px,100%);max-height:min(820px,calc(100dvh - 24px));overflow:hidden;border-radius:var(--radius-xl);background:var(--bg-elevated);color:var(--text);box-shadow:var(--shadow-xl);border:1px solid var(--border)}header{display:flex;justify-content:space-between;align-items:center;padding:20px 22px 12px}h2{margin:0;font-size:20px}h3{margin:0;font-size:15px}.close{border:0;background:transparent;color:inherit;font-size:22px;cursor:pointer}main{min-height:0;overflow:auto;padding:8px 22px 22px;display:grid;gap:14px}footer{padding:14px 22px;border-top:1px solid var(--border);background:var(--bg-elevated)}footer h3,footer p{margin:0}footer p{margin-top:6px}footer .row{margin-top:12px}.card,.agent-card{padding:15px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--card)}
      .coding-agents{display:grid;gap:10px}.coding-agents>h3{margin-top:2px}.agent-card{display:grid;gap:12px}.agent-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.agent-heading p,.disable-note,.check-note{margin:3px 0 0;color:var(--muted);font-size:12px}.disable-note{margin-top:-7px}.check-note{margin:0}.switch{display:flex;align-items:center;gap:7px;cursor:pointer;white-space:nowrap}.switch input{position:absolute;opacity:0;pointer-events:none}.switch span{position:relative;width:34px;height:20px;border-radius:99px;background:var(--border-strong);transition:background .15s ease}.switch span::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:white;box-shadow:0 1px 3px #0005;transition:transform .15s ease}.switch input:checked+span{background:var(--accent)}.switch input:checked+span::after{transform:translateX(14px)}.switch input:focus-visible+span{box-shadow:var(--focus-ring)}.switch input:disabled~*{opacity:.5;cursor:not-allowed}.switch b{font-size:12px}
      .agent-status ul{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:0;padding:0;list-style:none}.diagnostic{display:flex;gap:7px;min-width:0;padding:8px;border-radius:var(--radius-md);background:var(--bg);border:1px solid var(--border)}.diagnostic>span:first-child{display:grid;place-items:center;width:18px;height:18px;flex:none;border-radius:50%;font-weight:700;background:var(--bg-hover)}.diagnostic--passed>span:first-child{color:var(--ok)}.diagnostic--failed>span:first-child{color:var(--danger)}.diagnostic strong,.diagnostic small{display:block;overflow:hidden;text-overflow:ellipsis}.diagnostic small{color:var(--muted);margin-top:2px}.version{margin:6px 0 0;color:var(--muted);font-size:12px}.field{display:grid;gap:5px}.field>span:first-child{font-weight:600}.field small{color:var(--muted);font-family:var(--font-mono,monospace);font-size:11px}input,select{width:100%;padding:9px 10px;border-radius:var(--radius-md);border:1px solid var(--border-strong);background:var(--bg);color:var(--text)}input:focus,select:focus{border-color:var(--accent);outline:none;box-shadow:var(--focus-ring)}input[aria-invalid=true]{border-color:var(--danger)}.field-error{color:var(--danger);font-size:12px}.field-error:empty{display:none}
      .gateway{border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden}.gateway summary{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;padding:10px 11px;background:var(--bg)}.gateway summary::-webkit-details-marker{display:none}.gateway summary span:first-child{display:grid}.gateway summary small{color:var(--muted)}.gateway[open] .chevron{transform:rotate(180deg)}.gateway-fields{display:grid;gap:10px;padding:12px;border-top:1px solid var(--border)}.field-help{margin:0;color:var(--muted)}.configuration-error{margin:0;color:var(--danger);font-size:12px}.muted{color:var(--muted);margin:4px 0}.row,.agent-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.agent-actions{padding-top:2px}.button{border:1px solid var(--border-strong);border-radius:var(--radius-md);padding:8px 11px;background:var(--bg-elevated);color:var(--text);cursor:pointer}.button:hover:not(:disabled),.button:focus-visible{border-color:var(--border-hover);background:var(--bg-hover);outline:none}.primary{background:var(--accent);color:var(--accent-foreground);border-color:var(--accent)}.primary:hover:not(:disabled){background:var(--accent-hover);border-color:var(--accent-hover)}.button:disabled{opacity:.5;cursor:not-allowed}.message{padding:10px 12px;border-radius:var(--radius-md);background:var(--accent-subtle)}.message--error{color:var(--danger);border:1px solid color-mix(in srgb,var(--danger) 35%,transparent)}.confirm{box-shadow:inset 3px 0 0 var(--accent)}
      @media(max-width:560px){.modal{--openclaw-modal-width:calc(100vw - 12px);--openclaw-modal-max-height:calc(100dvh - 12px)}.panel{max-height:calc(100dvh - 12px);border-radius:var(--radius-lg)}header{padding:15px 15px 9px}main{padding:6px 15px 16px}footer{padding:11px 15px}.agent-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start}.agent-heading>div{grid-column:1;grid-row:1/3}.agent-heading>.switch{grid-column:2;grid-row:1;white-space:nowrap;justify-content:flex-end}.agent-heading>.agent-expand{grid-column:2;grid-row:2;white-space:nowrap}.switch b{font-size:11px}.agent-status ul{grid-template-columns:1fr}.agent-actions .button{flex:1 1 calc(50% - 4px)}.agent-actions .primary{flex-basis:100%}}
    </style><button class="badge" data-action="open" aria-label="${escapeHtml(t("platformClaw.execution.openSettings"))}"><span class="dot"></span><span>${escapeHtml(badgeLabel)}</span></button>${this.opened ? `<openclaw-modal-dialog class="modal" label="${escapeHtml(t("platformClaw.execution.workEnvironmentSettings"))}"><section class="panel"><header><h2>${escapeHtml(t("platformClaw.execution.workEnvironmentSettings"))}</h2><button class="close" data-action="close" aria-label="${escapeHtml(t("platformClaw.execution.close"))}">×</button></header>${this.renderTabs()}<main>${this.loading ? `<p>${escapeHtml(t("common.loading"))}</p>` : ""}${this.message ? `<div class="message ${this.messageKind === "error" ? "message--error" : ""}" role="${this.messageKind === "error" ? "alert" : "status"}">${escapeHtml(this.message)}</div>` : ""}${settings ? (this.activeTab === "location" ? this.renderLocationPanel(settings) : this.renderAgentsPanel(settings)) : ""}</main><footer data-confirmation-footer aria-live="polite">${this.pendingTarget ? `<section class="confirm"><h3>${escapeHtml(t("platformClaw.execution.confirmTitle"))}</h3><p>${escapeHtml(t("platformClaw.execution.confirmBody", { target: targetLabel }))}</p><div class="row"><button class="button primary" data-action="confirm-switch" autofocus ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.confirm"))}</button><button class="button" data-action="cancel-switch">${escapeHtml(t("platformClaw.execution.cancel"))}</button></div></section>` : ""}${this.pendingRelease ? `<section class="confirm"><h3>${escapeHtml(t("platformClaw.execution.releaseConfirmTitle"))}</h3><p>${escapeHtml(t("platformClaw.execution.releaseConfirmBody"))}</p><div class="row"><button class="button primary" data-action="confirm-release">${escapeHtml(t("platformClaw.execution.releaseConfirm"))}</button><button class="button" data-action="cancel-release">${escapeHtml(t("platformClaw.execution.cancel"))}</button></div></section>` : ""}${!this.pendingTarget && !this.pendingRelease ? `<button class="button" data-action="refresh" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.refresh"))}</button>` : ""}</footer></section></openclaw-modal-dialog>` : ""}`;
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
