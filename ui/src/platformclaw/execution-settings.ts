import {
  emptyCodingAgentConfiguration,
  type CodingAgentConfiguration,
  type CodingAgentId,
  type CodingAgentProbeResult,
} from "@platformclaw/coding-agent-contract";
import { render as renderLit } from "lit";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
import "../components/modal-dialog.ts";
import "../components/web-awesome-tabs.ts";
import { i18n } from "../i18n/index.ts";
import {
  applyCodingAgentDetection,
  EXECUTION_SETTINGS_ELEMENT_NAME,
  createExecutionTransition,
  executionMutationTarget,
  executionCredentialUpdateBody,
  reconcileExecutionMutation,
  requestExecutionSettings,
  resolveActiveExecutionConnectionId,
  resolveExecutionConnectionId,
  verifyExecutionTarget,
} from "./execution-settings-actions.ts";
import {
  bindExecutionSettingsEvents,
  type ExecutionSettingsAction,
} from "./execution-settings-events.ts";
import {
  EXECUTION_PROGRESS_SUCCESS_DELAY_MS,
  renderExecutionSettingsShell,
} from "./execution-settings-shell.ts";
import {
  AGENT_LABELS,
  type ClaudeEnvironmentKey,
  type ExecutionSettings,
  type ExecutionCodingAgentView,
  renderExecutionCodingAgents,
  type ExecutionTarget,
  type ExecutionAction,
  type ExecutionActivity,
  type ExecutionTransition,
  type VmSelectionDraft,
  codingAgentValidationErrors,
  canActivateVerifiedVm,
  completedExecutionActivity,
  canRetryExecutionProgress,
  hasExecutionProgress,
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
  private releaseConnectionId?: string;
  private editingVm = false;
  private progressVisible = false;
  private progressTimer: number | undefined;
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

  constructor() {
    super();
    bindExecutionSettingsEvents(this.root, (action) => this.dispatchAction(action));
  }
  connectedCallback(): void {
    this.unsubscribeLocale = i18n.subscribe(() => void this.renderLocale());
    void this.initialize();
  }
  disconnectedCallback(): void {
    this.clearProgressTimer();
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
    if (
      (hasExecutionProgress(this.activity) && this.activity.kind !== "success") ||
      canActivateVerifiedVm(this.settings, this.activity)
    ) {
      this.progressVisible = true;
    }
    this.render();
  }
  private clearProgressTimer(): void {
    window.clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
  }
  private hideProgress(): void {
    this.clearProgressTimer();
    this.progressVisible = false;
    // Dismissing the verified offer consumes it; reopening settings must respect Later.
    // Hiding an in-flight request leaves its eventual result untouched.
    if (this.activity.kind === "success" && this.activity.action === "credential") {
      this.activity = { ...this.activity, offerActivation: false };
    }
    if (this.activity.kind === "success" && this.activity.target) {
      this.root.querySelector("main")!.scrollTop = 0;
    }
    this.render();
  }
  private closeSettings(): void {
    this.opened = false;
    this.pendingRelease = false;
    this.hideProgress();
  }
  private async renderLocale(): Promise<void> {
    await loadPlatformClawLocale();
    if (this.isConnected) {
      this.render();
    }
  }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    return await requestExecutionSettings<T>(
      (url, options) => this.fetchImpl(url, options),
      () => this.onUnauthenticated(),
      path,
      init,
    );
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
      // Allocation changes invalidate the editor and coding-agent drafts together.
      this.editingVm = false;
      this.vmDraft = null;
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
  private async changeTarget(
    target: ExecutionTarget,
    connected: boolean,
    connectionId?: string,
    transition?: ExecutionTransition,
  ): Promise<void> {
    this.activity = { kind: "switching", target, connected, transition };
    this.render();
    const settings = await this.request<ExecutionSettings>(
      `${PLATFORMCLAW_EXECUTION_API_PATH}/target`,
      {
        method: "POST",
        body: JSON.stringify({
          target,
          ...(connectionId ? { connectionId } : {}),
          expectedRevision: this.settings!.targetRevision,
        }),
      },
    );
    this.applySettings(settings);
    verifyExecutionTarget(settings, target, connectionId);
  }

  private async mutate(
    action: ExecutionAction | ExecutionTarget,
    body?: unknown,
    connectedBefore = false,
    requestedConnectionId?: string,
    retryTransition?: ExecutionTransition,
  ): Promise<void> {
    if (this.busy || this.loading || !this.settings) {
      return;
    }
    const connectionId = resolveExecutionConnectionId(this.settings, action, requestedConnectionId);
    const previousRevision = this.settings.targetRevision;
    const previousAssignment = this.assignmentId;
    // Editor resets must not erase the in-flight selection used to reconcile a lost response.
    const requestedSelection = action === "selection" ? this.vmDraft : null;
    let connected = connectedBefore;
    const target = executionMutationTarget(action);
    const transition = createExecutionTransition({
      settings: this.settings,
      action,
      selection: requestedSelection,
      connectionId,
      retry: retryTransition,
    });
    this.clearProgressTimer();
    this.progressVisible = target !== null || action === "credential";
    this.activity =
      action === "selection"
        ? { kind: "connecting", transition }
        : action === "assigned_vm" || action === "platform_server"
          ? { kind: "switching", target: action, connected, transition }
          : { kind: "working", action };
    this.busy = true;
    this.message = "";
    this.messageKind = "info";
    this.render();
    try {
      if (action === "assigned_vm" || action === "platform_server") {
        await this.changeTarget(action, connected, connectionId, transition);
      } else {
        this.applySettings(
          await this.request<ExecutionSettings>(`${PLATFORMCLAW_EXECUTION_API_PATH}/${action}`, {
            method: "POST",
            ...(body === undefined
              ? {}
              : {
                  body: JSON.stringify(
                    action === "selection"
                      ? { ...(body as Record<string, unknown>), expectedRevision: previousRevision }
                      : body,
                  ),
                }),
          }),
        );
        if (action === "selection") {
          connected = true;
          // Registration and activation share one server-owned revision check.
          // A second browser mutation would expose a partial selection on failure.
          if (
            this.settings.activeTarget !== "assigned_vm" ||
            this.settings.assignment?.vmHostId !== requestedSelection?.vmHostId ||
            this.settings.assignment?.linuxAccount !== requestedSelection?.linuxAccount
          ) {
            throw new ExecutionRequestError(undefined, "platformClaw.execution.switchFailed");
          }
        }
      }
      this.pendingRelease = false;
      if (action === "release") {
        this.vmDraft = null;
      }
      this.activity = {
        ...completedExecutionActivity(this.settings, action, connected),
        transition,
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
      this.activity = reconcileExecutionMutation({
        settings: this.settings,
        action,
        previousAssignment,
        selection: requestedSelection,
        connected,
        connectionId,
        error,
        locationUnknown,
        transition,
      });
      if (action === "release" && this.activity.kind === "success") {
        this.vmDraft = null;
      }
    } finally {
      if (this.activity.kind === "success") {
        this.editingVm = false;
      }
      if (this.settings && this.settings.targetRevision !== previousRevision) {
        notifyPlatformClawExecutionTargetChanged();
      }
      this.busy = false;
      if (
        this.progressVisible &&
        this.activity.kind === "success" &&
        !canActivateVerifiedVm(this.settings, this.activity) &&
        this.isConnected
      ) {
        this.progressTimer = window.setTimeout(
          () => this.hideProgress(),
          EXECUTION_PROGRESS_SUCCESS_DELAY_MS,
        );
      }
      this.render();
    }
  }

  private configuration(agent: CodingAgentId): CodingAgentConfiguration {
    return this.codingAgentDrafts.get(agent) ?? emptyCodingAgentConfiguration(agent);
  }
  private validateCodingAgent(agent: CodingAgentId, action: "check" | "save"): boolean {
    const errors = codingAgentValidationErrors(this.configuration(agent), action);
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
    const dirty = this.codingAgentDirtyFields.get(agent) ?? new Set<string>();
    const errors = this.codingAgentErrors.get(agent);
    const current = applyCodingAgentDetection({
      agent,
      configuration: this.configuration(agent),
      probe,
      dirty,
      manual: this.codingAgentManualFields.get(agent) ?? new Set<string>(),
      errors,
    });
    if (agent === "claude" && current.agent === "claude" && probe.environment) {
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
  private dispatchAction(action: ExecutionSettingsAction): void {
    if (action.kind === "open") {
      return this.openSettings();
    }
    if (action.kind === "show-progress") {
      this.progressVisible = true;
      this.render();
      return;
    }
    if (action.kind === "close") {
      return this.closeSettings();
    }
    if (action.kind === "hide-progress" || action.kind === "back-to-settings") {
      return this.hideProgress();
    }
    if (action.kind === "gateway-toggle") {
      this.gatewayExpanded = action.open;
      return;
    }
    if (this.busy || this.loading) {
      return;
    }
    switch (action.kind) {
      case "activate-verified-vm":
        if (canActivateVerifiedVm(this.settings, this.activity)) {
          void this.mutate("assigned_vm", undefined, true);
        }
        break;
      case "retry-progress":
        if (
          canRetryExecutionProgress(this.settings, this.activity) &&
          this.activity.kind === "error" &&
          this.activity.target
        ) {
          void this.mutate(
            this.activity.target,
            undefined,
            this.activity.connection === "complete",
            this.activity.transition?.to.connectionId,
            this.activity.transition,
          );
        }
        break;
      case "tab":
        if (
          (action.tab === "location" || action.tab === "agents") &&
          action.tab !== this.activeTab
        ) {
          this.activeTab = action.tab;
          this.render();
        }
        break;
      case "vm-draft":
        this.vmDraft = action.draft;
        break;
      case "selection":
        this.vmDraft = action.draft;
        void this.mutate("selection", { ...action.draft, password: action.password });
        break;
      case "agent-field":
        this.updateDraft(action.agent, action.field, action.value);
        break;
      case "agent-toggle":
        this.updateDraft(action.agent, "enabled", action.enabled);
        if (action.enabled && !this.validateCodingAgent(action.agent, "save")) {
          this.expandedAgents.add(action.agent);
        }
        this.render();
        break;
      case "agent-action":
        if (action.action === "expand") {
          if (this.expandedAgents.has(action.agent)) {
            this.expandedAgents.delete(action.agent);
          } else {
            this.expandedAgents.add(action.agent);
          }
          this.render();
        } else {
          void this.codingAgentRequest(action.action, action.agent);
        }
        break;
      case "edit-vm":
      case "cancel-edit-vm":
        if (this.settings) {
          this.editingVm = action.kind === "edit-vm";
          this.render();
        }
        break;
      case "target":
        void this.mutate(action.target, undefined, false, action.connectionId);
        break;
      case "connect-vm":
      case "configure-vm": {
        if (!this.settings) {
          break;
        }
        const connection =
          action.kind === "configure-vm"
            ? this.settings.savedVms.find((vm) => vm.id === action.connectionId)
            : undefined;
        if (action.kind === "configure-vm" && !connection) {
          break;
        }
        this.vmDraft = {
          vmHostId: connection?.vmHostId ?? (action.kind === "connect-vm" ? action.vmHostId : ""),
          linuxAccount: connection?.linuxAccount ?? this.settings.accountId,
        };
        this.editingVm = true;
        this.render();
        this.root
          .querySelector<HTMLInputElement>("form[data-action='select-vm'] input[name='password']")
          ?.focus();
        break;
      }
      case "forget-vm":
        this.releaseConnectionId = action.connectionId;
        this.pendingRelease = true;
        this.render();
        this.root.querySelector<HTMLElement>("[data-action='confirm-release']")?.focus();
        break;
      case "refresh":
        void this.refresh();
        break;
      case "test":
        void this.mutate("test");
        break;
      case "credential":
        if (this.settings) {
          void this.mutate(
            "credential",
            executionCredentialUpdateBody(this.settings, action.password),
          );
        }
        break;
      case "release":
      case "cancel-release":
        this.releaseConnectionId = resolveActiveExecutionConnectionId(this.settings);
        this.pendingRelease = action.kind === "release";
        this.render();
        this.root
          .querySelector<HTMLElement>(
            this.pendingRelease ? "[data-action='confirm-release']" : "[data-action='release']",
          )
          ?.focus();
        break;
      case "confirm-release":
        this.pendingRelease = false;
        void this.mutate(
          "release",
          { connectionId: this.releaseConnectionId },
          false,
          this.releaseConnectionId,
        );
        break;
    }
  }

  private codingAgentViews(): ExecutionCodingAgentView[] {
    return AGENTS.map((agent) => ({
      configuration: this.configuration(agent),
      saved: this.settings?.codingAgents.find((item) => item.configuration.agent === agent),
      dirtyFields: [...(this.codingAgentDirtyFields.get(agent) ?? [])],
      probe: this.codingAgentProbes.get(agent),
      probeKind: this.codingAgentProbeKinds.get(agent),
      probeTime: this.codingAgentProbeTimes.get(agent),
      errors: { ...this.codingAgentErrors.get(agent) },
      expanded: this.expandedAgents.has(agent),
      gatewayExpanded: this.gatewayExpanded,
      busyAction: this.busyAgentAction?.agent === agent ? this.busyAgentAction.action : null,
    }));
  }
  private render(): void {
    const bodyMarkup =
      this.settings && this.activeTab === "agents"
        ? renderExecutionCodingAgents(this.settings, this.busy, this.codingAgentViews())
        : "";
    // Lit retains both native-dialog owners across phase updates. Only source-owned,
    // escaped form markup is replaced inside their stable shells.
    renderLit(
      renderExecutionSettingsShell({
        settings: this.settings,
        activity: this.activity,
        opened: this.opened,
        progressVisible: this.progressVisible,
        busy: this.busy,
        loading: this.loading,
        pendingRelease: this.pendingRelease,
        activeTab: this.activeTab,
        editingVm: this.editingVm,
        vmDraft: this.vmDraft,
        bodyMarkup,
        message: this.message,
        messageKind: this.messageKind,
        canRetryProgress: canRetryExecutionProgress(this.settings, this.activity),
      }),
      this.root,
    );
    this.root
      .querySelector<OpenClawModalDialog>("[data-progress-modal]")
      ?.setReturnFocusTarget(this.root.querySelector<HTMLElement>("[data-settings-heading]"));
  }
}

if (!customElements.get(EXECUTION_SETTINGS_ELEMENT_NAME)) {
  customElements.define(EXECUTION_SETTINGS_ELEMENT_NAME, PlatformClawExecutionSettingsElement);
}
export { mountPlatformClawExecutionSettings } from "./execution-settings-actions.ts";
