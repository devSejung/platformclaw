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
  type ClaudeEnvironmentKey,
  type ExecutionSettings,
  type ExecutionTarget,
  type ExecutionAction,
  type ExecutionActivity,
  type VmSelectionDraft,
  renderExecutionLocation,
  renderExecutionProgress,
  executionStatusView,
  renderExecutionTabs,
  executionCodingAgentSummary,
  renderExecutionDiagnostics,
  renderExecutionAgentField,
  renderExecutionSettingsStyles,
  escapeHtml,
  formText,
  hasLiteralSurroundingQuotes,
  ExecutionRequestError,
  executionErrorMessage,
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
  private activity: ExecutionActivity = { kind: "idle" };
  private vmDraft: VmSelectionDraft | null = null;
  private assignmentId = "";
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
      this.applySettings(this.initialSettings);
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
      throw new ExecutionRequestError(undefined, "platformClaw.execution.sessionExpired");
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new ExecutionRequestError(body.error, "platformClaw.execution.requestFailed");
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
  private resetCodingAgentDraftState(): void {
    this.codingAgentDrafts.clear();
    this.codingAgentDirtyFields.clear();
    this.codingAgentManualFields.clear();
    this.codingAgentProbes.clear();
    this.codingAgentProbeKinds.clear();
    this.codingAgentProbeTimes.clear();
    this.codingAgentErrors.clear();
  }
  private applySettings(settings: ExecutionSettings): void {
    const previousAssignment = this.assignmentId;
    this.assignmentId = settings.assignment?.id ?? "";
    this.settings = settings;
    if (previousAssignment !== this.assignmentId) {
      this.resetCodingAgentDraftState();
      this.syncCodingAgentDrafts(settings, true);
    } else {
      this.syncCodingAgentDrafts(settings);
    }
  }
  private async refresh(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.loading = true;
    this.activity = { kind: "idle" };
    this.render();
    try {
      this.applySettings(await this.request<ExecutionSettings>(PLATFORMCLAW_EXECUTION_API_PATH));
      this.message = "";
    } catch (error) {
      this.message = executionErrorMessage(error);
      this.messageKind = "error";
    } finally {
      this.loading = false;
      this.render();
    }
  }
  private async changeTarget(target: ExecutionTarget, connected: boolean): Promise<void> {
    this.activity = { kind: "switching", target, connected };
    this.render();
    const settings = await this.request<ExecutionSettings>(
      `${PLATFORMCLAW_EXECUTION_API_PATH}/target`,
      {
        method: "POST",
        body: JSON.stringify({ target, expectedRevision: this.settings!.targetRevision }),
      },
    );
    this.applySettings(settings);
    if (settings.activeTarget !== target) {
      throw new ExecutionRequestError(undefined, "platformClaw.execution.switchFailed");
    }
  }

  private async mutate(action: ExecutionAction | ExecutionTarget, body?: unknown): Promise<void> {
    if (this.busy || this.loading || !this.settings) {
      return;
    }
    const previousRevision = this.settings.targetRevision;
    const previousAssignment = this.assignmentId;
    let connected = false;
    this.activity =
      action === "selection"
        ? { kind: "connecting" }
        : action === "assigned_vm" || action === "platform_server"
          ? { kind: "switching", target: action, connected: false }
          : { kind: "working", action };
    this.busy = true;
    this.message = "";
    this.messageKind = "info";
    this.render();
    try {
      if (action === "assigned_vm" || action === "platform_server") {
        await this.changeTarget(action, false);
      } else {
        this.applySettings(
          await this.request<ExecutionSettings>(`${PLATFORMCLAW_EXECUTION_API_PATH}/${action}`, {
            method: "POST",
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        if (action === "selection") {
          connected = true;
          // Selection stores a verified VM; Gateway still owns the guarded target change.
          // Use its returned revision so a concurrent location change cannot be overwritten.
          await this.changeTarget("assigned_vm", true);
        }
      }
      this.pendingRelease = false;
      if (action === "release") {
        this.vmDraft = null;
      }
      this.activity = {
        kind: "success",
        connection: connected ? "complete" : null,
        target:
          action === "selection" || action === "assigned_vm" || action === "platform_server"
            ? this.settings.activeTarget
            : null,
      };
    } catch (error) {
      // A failed response can follow a committed selection or target change. Reconcile
      // from the owner instead of presenting the previous location as current.
      let locationUnknown = false;
      try {
        this.applySettings(await this.request<ExecutionSettings>(PLATFORMCLAW_EXECUTION_API_PATH));
      } catch {
        this.settings = null;
        locationUnknown = true;
      }
      if (
        action === "selection" &&
        this.settings?.assignment &&
        this.settings.assignment.id !== previousAssignment &&
        this.settings.assignment.vmHostId === this.vmDraft?.vmHostId &&
        this.settings.assignment.linuxAccount === this.vmDraft?.linuxAccount &&
        this.settings.assignment.status === "ready" &&
        this.settings.credentialStatus === "current"
      ) {
        connected = true;
      }
      this.activity = {
        kind: "error",
        connection: connected ? "complete" : action === "selection" ? "failed" : null,
        error,
        locationUnknown,
      };
      const requestedTarget =
        action === "selection" || action === "assigned_vm"
          ? "assigned_vm"
          : action === "platform_server"
            ? "platform_server"
            : null;
      const released = action === "release" && this.settings && !this.settings.assignment;
      // Release has an observable end state. Current credentials/ready status can predate
      // a failed save/check, so they cannot prove that particular request succeeded.
      if (
        released ||
        (requestedTarget &&
          this.settings?.activeTarget === requestedTarget &&
          (action !== "selection" ||
            (connected &&
              this.settings.assignment?.vmHostId === this.vmDraft?.vmHostId &&
              this.settings.assignment?.linuxAccount === this.vmDraft?.linuxAccount)))
      ) {
        if (released) {
          this.vmDraft = null;
        }
        this.activity = {
          kind: "success",
          connection: action === "selection" ? "complete" : null,
          target: requestedTarget,
        };
      }
    } finally {
      if (this.settings && this.settings.targetRevision !== previousRevision) {
        notifyPlatformClawExecutionTargetChanged();
      }
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
      this.loading ||
      !this.settings ||
      (action !== "detect" && !this.validateCodingAgent(agent, action))
    ) {
      return;
    }
    this.busy = true;
    this.busyAgentAction = { agent, action };
    this.activity = { kind: "idle" };
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
        this.applySettings(result as ExecutionSettings);
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
  private renderAgentsPanel(settings: ExecutionSettings): string {
    const assignment = settings.assignment;
    return `<section class="tab-panel coding-agents" id="execution-panel-agents" role="tabpanel" aria-labelledby="execution-tab-agents">${assignment ? `<p class="agent-context">${escapeHtml(assignment.vmLabel)} · ${escapeHtml(assignment.linuxAccount)}</p><p class="agent-shared-help">${escapeHtml(t("platformClaw.execution.agentOffHelp"))}</p>${AGENTS.map((agent) => this.renderCodingAgent(agent)).join("")}` : `<p class="muted">${escapeHtml(t("platformClaw.execution.noAvailableVm"))}</p>`}</section>`;
  }
  private bindEvents(): void {
    const closeDialog = () => {
      this.opened = false;
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
    this.root.querySelector("wa-tab-group")?.addEventListener("wa-tab-show", (event) => {
      const tab = (event as CustomEvent<{ name: string }>).detail.name;
      if ((tab === "location" || tab === "agents") && tab !== this.activeTab) {
        this.activeTab = tab;
        this.render();
      }
    });
    for (const tab of this.root.querySelectorAll<HTMLElement>("[data-settings-tab]")) {
      tab.addEventListener("click", () => {
        this.activeTab = tab.dataset.settingsTab === "agents" ? "agents" : "location";
        this.render();
      });
    }
    this.root
      .querySelector<HTMLElement>("[data-action='test']")
      ?.addEventListener("click", () => void this.mutate("test"));
    this.root
      .querySelector<HTMLElement>("[data-action='credential']")
      ?.addEventListener("click", () => {
        const password = this.root.querySelector<HTMLInputElement>("[data-password]")?.value ?? "";
        void this.mutate("credential", { password });
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
        this.vmDraft = {
          vmHostId: formText(form, "vmHostId"),
          linuxAccount: formText(form, "linuxAccount"),
        };
        void this.mutate("selection", {
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
        void this.mutate("release");
      });
    for (const button of this.root.querySelectorAll<HTMLElement>("[data-target]")) {
      button.addEventListener("click", () => {
        const target = button.dataset.target;
        if (target === "platform_server" || target === "assigned_vm") {
          void this.mutate(target);
        }
      });
    }
    const form = this.root.querySelector<HTMLFormElement>("[data-action='select-vm']");
    form?.addEventListener("input", () => {
      const data = new FormData(form);
      this.vmDraft = {
        vmHostId: formText(data, "vmHostId"),
        linuxAccount: formText(data, "linuxAccount"),
      };
    });
  }

  private renderField(
    agent: CodingAgentId,
    field: string,
    label: string,
    value: string,
    secondary?: string,
  ): string {
    return renderExecutionAgentField(
      agent,
      field,
      label,
      value,
      secondary,
      this.codingAgentErrors.get(agent)?.[field],
      this.busy,
    );
  }
  private renderDiagnostics(agent: CodingAgentId, settings?: PersonalCodingAgentSettings): string {
    return renderExecutionDiagnostics(
      this.codingAgentProbes.get(agent) ?? settings?.lastCheck,
      [...(this.codingAgentDirtyFields.get(agent) ?? [])].some((field) => field !== "enabled"),
      this.codingAgentProbeKinds.get(agent) === "detect",
      this.codingAgentProbeTimes.get(agent),
    );
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
    return `<section class="agent-card${expanded ? "" : " is-collapsed"}" data-coding-agent="${agent}" ${this.busyAgentAction?.agent === agent ? `aria-busy="true"` : ""}><div class="agent-heading"><div><h3>${AGENT_LABELS[agent]}</h3><p>${escapeHtml(savedEnabled ? t("platformClaw.execution.agentSavedOn") : t("platformClaw.execution.agentSavedOff"))}</p>${dirty ? `<p class="unsaved">${escapeHtml(t("platformClaw.execution.agentUnsaved"))}</p>` : ""}<p class="compact-check">${escapeHtml(executionCodingAgentSummary(saved))}</p>${dirty && !expanded ? `<button class="button agent-quick-save" data-agent-quick-save="${agent}" ${!canEditConfig || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.agentSaveChanges"))}</button>` : ""}</div><button class="agent-expand" data-agent-expand="${agent}" type="button" aria-expanded="${expanded}" aria-controls="agent-settings-${agent}">${escapeHtml(t(expanded ? "platformClaw.execution.agentCollapse" : "platformClaw.execution.agentConfigure"))}</button><label class="switch"><input type="checkbox" role="switch" aria-label="${escapeHtml(t("platformClaw.execution.useAgent", { agent: AGENT_LABELS[agent] }))}" data-agent-toggle="${agent}" ${configuration.enabled ? "checked" : ""} ${!canEditConfig || this.busy ? "disabled" : ""}><span aria-hidden="true"></span><b>${escapeHtml(t("platformClaw.execution.agentToggleShort"))}</b></label></div><div class="agent-settings" id="agent-settings-${agent}">${progress}${this.renderDiagnostics(agent, saved)}${this.renderField(agent, "executablePath", t("platformClaw.execution.agentExecutable"), configuration.executablePath, t("platformClaw.execution.agentAbsolutePath"))}${gateway}${configurationError ? `<p class="configuration-error" role="alert">${escapeHtml(configurationError)}</p>` : ""}<p class="check-note">${escapeHtml(t("platformClaw.execution.agentCheckTokens"))}</p><div class="agent-actions"><button class="button" data-agent-action="${agent}-detect" ${!canProbe || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.agentDetect"))}</button><button class="button" data-agent-action="${agent}-check" ${!canProbe || this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.agentCheck"))}</button><button class="button primary" data-agent-action="${agent}-save" ${!canEditConfig || this.busy ? "disabled" : ""}>${escapeHtml(dirty ? t("platformClaw.execution.agentSaveChanges") : t("platformClaw.execution.agentSave"))}</button></div></div></section>`;
  }
  private render(): void {
    const settings = this.settings;
    const activity = this.activity;
    const { badgeLabel, busyMessage, message, messageKind, warn } = executionStatusView(
      settings,
      activity,
      this.message,
      this.messageKind,
    );
    this.root.innerHTML = `${renderExecutionSettingsStyles(warn)}<button class="badge" data-action="open" aria-busy="${this.busy}" aria-label="${escapeHtml(t("platformClaw.execution.openSettings"))}"><span class="dot" aria-hidden="true"></span><span>${escapeHtml(busyMessage || badgeLabel)}</span></button>${this.opened ? `<openclaw-modal-dialog class="modal" label="${escapeHtml(t("platformClaw.execution.workEnvironmentSettings"))}"><section class="panel"><header><h2>${escapeHtml(t("platformClaw.execution.workEnvironmentSettings"))}</h2><button class="close" data-action="close" aria-label="${escapeHtml(t("platformClaw.execution.close"))}">×</button></header>${renderExecutionTabs(this.activeTab)}<main aria-busy="${this.busy}">${this.loading ? `<p>${escapeHtml(t("common.loading"))}</p>` : ""}${renderExecutionProgress(activity)}${message ? `<div class="message message--${messageKind}" role="${messageKind === "error" ? "alert" : "status"}">${escapeHtml(message)}</div>` : ""}${settings ? (this.activeTab === "location" ? renderExecutionLocation(settings, this.busy || this.loading, this.vmDraft) : this.renderAgentsPanel(settings)) : ""}</main><footer data-confirmation-footer aria-live="polite">${this.pendingRelease ? `<section class="confirm"><h3>${escapeHtml(t("platformClaw.execution.releaseConfirmTitle"))}</h3><p>${escapeHtml(t("platformClaw.execution.releaseConfirmBody"))}</p><div class="row"><button class="button primary" data-action="confirm-release">${escapeHtml(t("platformClaw.execution.releaseConfirm"))}</button><button class="button" data-action="cancel-release">${escapeHtml(t("platformClaw.execution.cancel"))}</button></div></section>` : ""}${!this.pendingRelease ? `<button class="button" data-action="refresh" ${this.busy || this.loading ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.refresh"))}</button>` : ""}</footer></section></openclaw-modal-dialog>` : ""}`;
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
