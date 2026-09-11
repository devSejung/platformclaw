import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGateway,
  type ApplicationGatewaySnapshot,
} from "../../../app/context.ts";
import {
  showConfirmDialog,
  type ConfirmDialogOptions,
} from "../../../components/confirm-dialog.ts";
import type { MemoryItemActions } from "../../../components/memory-item-actions.ts";
import { renderSettingsDefaultState, renderSettingsRow } from "../../../components/settings-ui.ts";
import { t } from "../../../i18n/index.ts";
import { currentConfigObject } from "../../../lib/config/index.ts";
import { isGatewayMethodAdvertised } from "../../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import {
  backfillDreamDiary,
  canCallDreamingMethod,
  copyDreamingArchivePath,
  createDreamingState,
  dedupeDreamDiary,
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiGraph,
  loadWikiOverview,
  isMemoryWikiAvailable,
  repairDreamingArtifacts,
  resetGroundedShortTerm,
  resetDreamDiary,
  resolveConfiguredDreaming,
  updateDreamingEnabled,
  type DreamingState,
} from "./dreaming.ts";
import {
  createMemoryPanelGatewayState,
  preventDirtyWikiUnload,
  resolveDreamingNextCycle,
  type DreamingTaskScope,
} from "./memory-panel-helpers.ts";
import { renderDreamingToggleConfirmation } from "./toggle-confirmation.ts";
import {
  createDreamingViewState,
  renderDreaming,
  renderWikiKnowledge,
  resetWikiPreview,
  type DreamingViewState,
  type WikiGraphRenderer,
} from "./view.ts";
import { requestWikiPage, saveWikiPage } from "./wiki-document-client.ts";
import type { WikiPagePreview } from "./wiki-page-preview.ts";

class AgentMemoryPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) agentId = "";
  @property({ type: Boolean }) summaryOnly = false;
  @property() surface: "dreaming" | "wiki" = "dreaming";
  @property({ type: Number }) refreshRevision = 0;
  @property({ attribute: false }) wikiActions?: MemoryItemActions;

  @state() private dreaming = createDreamingState();
  @state() private toggleConfirmOpen = false;
  @state() private toggleConfirmLoading = false;
  @state() private pendingEnabled: boolean | null = null;
  @state() private wikiGraphRenderer: WikiGraphRenderer | null = null;

  private readonly viewState: DreamingViewState = createDreamingViewState();
  private wikiGraphRendererLoad: Promise<WikiGraphRenderer> | null = null;
  private gatewaySource: ApplicationGateway | null = null;
  private gatewayBindingEpoch = 0;
  private gatewayEpoch = 0;
  private hasBoundGatewaySource = false;
  private readonly preventDirtyWikiUnload = (event: BeforeUnloadEvent) =>
    preventDirtyWikiUnload(event, this.viewState);
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const sourceReplaced = this.hasBoundGatewaySource;
        this.hasBoundGatewaySource = true;
        this.gatewaySource = gateway;
        const bindingEpoch = ++this.gatewayBindingEpoch;
        this.gatewayEpoch += 1;
        const cleanup = gateway.subscribe((snapshot) => {
          if (this.isGatewayBindingCurrent(gateway, bindingEpoch)) {
            this.applyGatewaySnapshot(snapshot);
          }
        });
        this.applyGatewaySnapshot(gateway.snapshot, sourceReplaced ? "replacement" : "initial");
        return cleanup;
      },
    )
    .effect(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        this.syncConfigSnapshot();
        return runtimeConfig.subscribe(() => {
          this.syncConfigSnapshot();
          this.requestUpdate();
        });
      },
    );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("agentId")) {
      this.applyAgentId();
    }
    if (changed.has("refreshRevision") && changed.get("refreshRevision") !== undefined) {
      // A confirmed deletion invalidates in-flight reads and any open page preview.
      this.gatewayEpoch += 1;
      this.resetTransientState();
      this.dreaming = this.createGatewayState();
      void this.loadAll();
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("beforeunload", this.preventDirtyWikiUnload);
  }

  override disconnectedCallback() {
    window.removeEventListener("beforeunload", this.preventDirtyWikiUnload);
    this.subscriptions.clear();
    this.gatewayBindingEpoch += 1;
    this.gatewayEpoch += 1;
    this.gatewaySource = null;
    this.resetTransientState();
    this.dreaming = createDreamingState();
    super.disconnectedCallback();
  }

  private isGatewayBindingCurrent(gateway: ApplicationGateway, bindingEpoch: number): boolean {
    return (
      this.isConnected &&
      this.gatewaySource === gateway &&
      this.gatewayBindingEpoch === bindingEpoch &&
      this.context.gateway === gateway
    );
  }

  private captureTaskScope(): DreamingTaskScope | null {
    const gateway = this.gatewaySource;
    if (!gateway) {
      return null;
    }
    return { gateway, epoch: this.gatewayEpoch, state: this.dreaming };
  }

  private isTaskScopeCurrent(scope: DreamingTaskScope): boolean {
    return (
      this.isConnected &&
      this.gatewaySource === scope.gateway &&
      this.gatewayEpoch === scope.epoch &&
      this.context.gateway === scope.gateway &&
      this.dreaming === scope.state
    );
  }

  private resetTransientState() {
    resetWikiPreview(this.viewState);
    this.toggleConfirmOpen = false;
    this.toggleConfirmLoading = false;
    this.pendingEnabled = null;
  }

  private createGatewayState(snapshot = this.context.gateway.snapshot): DreamingState {
    return createMemoryPanelGatewayState(this.context, this.agentId, snapshot);
  }

  private applyGatewaySnapshot(
    snapshot: ApplicationGatewaySnapshot,
    sourceBind?: "initial" | "replacement",
  ) {
    const clientChanged = this.dreaming.client !== snapshot.client;
    const connectionChanged = this.dreaming.connected !== (snapshot.phase === "connected");
    const becameConnected = snapshot.phase === "connected" && !this.dreaming.connected;
    const replaceState = sourceBind === "replacement" || clientChanged || connectionChanged;
    if (connectionChanged) {
      this.gatewayEpoch += 1;
    }
    if (replaceState) {
      this.dreaming = this.createGatewayState(snapshot);
      if (sourceBind !== "initial") {
        this.resetTransientState();
      }
    } else {
      this.dreaming.connected = snapshot.phase === "connected";
      this.dreaming.hello = snapshot.hello;
      this.dreaming.applySessionKey = snapshot.sessionKey;
    }
    if (snapshot.phase === "connected" && (replaceState || becameConnected)) {
      void this.loadAll();
    }
    this.requestUpdate();
  }

  private applyAgentId() {
    const agentId = this.agentId.trim();
    if (!agentId || this.dreaming.selectedAgentId === agentId) {
      return;
    }
    this.gatewayEpoch += 1;
    this.resetTransientState();
    this.dreaming = this.createGatewayState();
    if (this.dreaming.connected) {
      void this.loadAll();
    }
  }

  private syncConfigSnapshot() {
    this.dreaming.configSnapshot = this.context.runtimeConfig.state.configSnapshot;
  }

  private async runDreamingTask<T>(
    task: (state: DreamingState) => Promise<T>,
    scope = this.captureTaskScope(),
  ): Promise<T | undefined> {
    if (!scope || !this.isTaskScopeCurrent(scope)) {
      return undefined;
    }
    const result = task(scope.state);
    this.requestUpdate();
    try {
      const value = await result;
      return this.isTaskScopeCurrent(scope) ? value : undefined;
    } finally {
      if (this.isTaskScopeCurrent(scope)) {
        this.requestUpdate();
      }
    }
  }

  private async confirmDreamingTask(
    task: (state: DreamingState) => Promise<boolean>,
    confirmation: ConfirmDialogOptions,
  ) {
    const scope = this.captureTaskScope();
    if (!scope || !(await showConfirmDialog(confirmation)) || !this.isTaskScopeCurrent(scope)) {
      return;
    }
    await this.runDreamingTask(task, scope);
  }

  private async loadAll(refreshConfig = false) {
    const scope = this.captureTaskScope();
    if (!scope || !scope.state.client || !scope.state.connected) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    if (isGatewayMethodAdvertised(scope.state, "config.get") !== false) {
      try {
        if (refreshConfig) {
          await runtimeConfig.refresh();
        } else {
          await runtimeConfig.ensureLoaded();
        }
      } catch {
        // Restricted browser gateways intentionally omit config.get. Memory reads
        // remain independently available through their advertised methods.
      }
    }
    if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
      return;
    }
    this.syncConfigSnapshot();
    await Promise.all([
      this.runDreamingTask(loadDreamingStatus, scope),
      this.runDreamingTask(loadDreamDiary, scope),
      this.runDreamingTask(loadWikiImportInsights, scope),
      this.runDreamingTask(loadWikiOverview, scope),
    ]);
    if (
      this.isTaskScopeCurrent(scope) &&
      this.surface === "wiki" &&
      this.viewState.wikiLayout === "graph"
    ) {
      await this.loadWikiGraphView(scope);
    }
  }

  private async loadWikiGraphView(scope = this.captureTaskScope()) {
    if (!scope || !this.isTaskScopeCurrent(scope)) {
      return;
    }
    try {
      this.wikiGraphRendererLoad ??= import("./wiki-graph.runtime.ts").then(
        (module) => module.renderWikiGraph,
      );
      const renderer = await this.wikiGraphRendererLoad;
      if (!this.isTaskScopeCurrent(scope)) {
        return;
      }
      this.wikiGraphRenderer = renderer;
      this.requestUpdate();
      await this.runDreamingTask(loadWikiGraph, scope);
    } catch (error) {
      this.wikiGraphRendererLoad = null;
      if (this.isTaskScopeCurrent(scope)) {
        scope.state.wikiGraphLoading = false;
        scope.state.wikiGraphError = String(error);
        this.requestUpdate();
      }
    }
  }

  private setEnabled(enabled: boolean, dreamingOn: boolean) {
    if (
      !canCallDreamingMethod(this.dreaming, "config.patch", "operator.admin") ||
      this.dreaming.dreamingModeSaving ||
      this.toggleConfirmLoading ||
      this.toggleConfirmOpen ||
      dreamingOn === enabled
    ) {
      return;
    }
    this.pendingEnabled = enabled;
    this.toggleConfirmOpen = true;
    this.dreaming.dreamingStatusError = null;
  }

  private cancelToggle() {
    if (this.toggleConfirmLoading) {
      return;
    }
    this.toggleConfirmOpen = false;
    this.pendingEnabled = null;
    this.dreaming.dreamingStatusError = null;
  }

  private async confirmToggle() {
    const enabled = this.pendingEnabled;
    if (
      enabled == null ||
      this.toggleConfirmLoading ||
      !canCallDreamingMethod(this.dreaming, "config.patch", "operator.admin")
    ) {
      return;
    }
    this.toggleConfirmLoading = true;
    this.dreaming.dreamingStatusError = null;
    const scope = this.captureTaskScope();
    const runtimeConfig = this.context.runtimeConfig;
    if (!scope) {
      this.toggleConfirmLoading = false;
      return;
    }
    try {
      const canDispatch = () =>
        this.isTaskScopeCurrent(scope) &&
        this.context.runtimeConfig === runtimeConfig &&
        canCallDreamingMethod(scope.state, "config.patch", "operator.admin");
      const updated = await this.runDreamingTask(
        (dreamingState) =>
          updateDreamingEnabled(dreamingState, runtimeConfig, enabled, canDispatch),
        scope,
      );
      if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
        return;
      }
      if (!updated) {
        this.dreaming.dreamingStatusError ??= t("dreaming.toggleConfirmation.failed");
        return;
      }
      await runtimeConfig.refresh();
      if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
        return;
      }
      this.syncConfigSnapshot();
      await this.runDreamingTask(loadDreamingStatus, scope);
      if (!this.isTaskScopeCurrent(scope)) {
        return;
      }
      this.toggleConfirmOpen = false;
      this.pendingEnabled = null;
    } finally {
      if (this.isTaskScopeCurrent(scope)) {
        this.toggleConfirmLoading = false;
      }
    }
  }

  private async removeEnabledOverride(
    scope: DreamingTaskScope,
    runtimeConfig: ApplicationContext["runtimeConfig"],
  ): Promise<boolean> {
    const { pluginId } = resolveConfiguredDreaming(currentConfigObject(runtimeConfig.state));
    this.dreaming.dreamingModeSaving = true;
    try {
      const saved = await runtimeConfig.patch({
        raw: {
          plugins: {
            entries: {
              [pluginId]: { config: { dreaming: { enabled: null } } },
            },
          },
        },
        note: "Dreaming settings reset to the plugin default.",
        canDispatch: () =>
          this.isTaskScopeCurrent(scope) &&
          this.context.runtimeConfig === runtimeConfig &&
          canCallDreamingMethod(scope.state, "config.patch", "operator.admin"),
      });
      return saved;
    } catch (error) {
      if (this.isTaskScopeCurrent(scope) && this.context.runtimeConfig === runtimeConfig) {
        this.dreaming.dreamingStatusError =
          error instanceof Error ? error.message : t("dreaming.actions.updateFailed");
      }
      return false;
    } finally {
      if (this.isTaskScopeCurrent(scope)) {
        this.dreaming.dreamingModeSaving = false;
      }
    }
  }

  private async resetEnabledOverride(configured: ReturnType<typeof resolveConfiguredDreaming>) {
    if (
      !configured.overridden ||
      this.dreaming.dreamingModeSaving ||
      this.toggleConfirmOpen ||
      !canCallDreamingMethod(this.dreaming, "config.patch", "operator.admin")
    ) {
      return;
    }
    this.dreaming.dreamingStatusError = null;
    const scope = this.captureTaskScope();
    const runtimeConfig = this.context.runtimeConfig;
    if (!scope) {
      return;
    }
    const updated = await this.removeEnabledOverride(scope, runtimeConfig);
    if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
      return;
    }
    if (!updated) {
      this.dreaming.dreamingStatusError ??= t("dreaming.actions.updateFailed");
      return;
    }
    await runtimeConfig.refresh();
    if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
      return;
    }
    this.syncConfigSnapshot();
    await this.runDreamingTask(loadDreamingStatus, scope);
  }

  private async openWikiPage(lookup: string): Promise<WikiPagePreview | null> {
    const scope = this.captureTaskScope();
    const client = scope?.state.client;
    if (!scope || !client || !scope.state.connected) {
      return null;
    }
    const agentId = scope.state.selectedAgentId?.trim() || null;
    return await requestWikiPage({
      client,
      lookup,
      agentId,
      isCurrent: () =>
        this.isTaskScopeCurrent(scope) && (scope.state.selectedAgentId?.trim() || null) === agentId,
    });
  }

  private async saveWikiPage(params: {
    path: string;
    editMode: "body" | "notes";
    content: string;
    expectedRevision: string;
  }): Promise<WikiPagePreview | null> {
    const scope = this.captureTaskScope();
    const client = scope?.state.client;
    if (!scope || !client || !scope.state.connected) {
      return null;
    }
    const agentId = scope.state.selectedAgentId?.trim() || null;
    const saved = await saveWikiPage({
      client,
      document: params,
      agentId,
      isCurrent: () =>
        this.isTaskScopeCurrent(scope) && (scope.state.selectedAgentId?.trim() || null) === agentId,
    });
    if (!saved) {
      return null;
    }
    void this.refreshWikiData(loadWikiOverview);
    if (this.surface === "wiki" && this.viewState.wikiLayout === "graph") {
      void this.loadWikiGraphView();
    }
    return saved;
  }

  private async refreshWikiData(task: (state: DreamingState) => Promise<void>) {
    const scope = this.captureTaskScope();
    if (!scope) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    if (isGatewayMethodAdvertised(scope.state, "config.get") !== false) {
      try {
        await runtimeConfig.refresh();
      } catch {
        // A config refresh failure must not block an independently authorized wiki read.
      }
    }
    if (!this.isTaskScopeCurrent(scope) || this.context.runtimeConfig !== runtimeConfig) {
      return;
    }
    this.syncConfigSnapshot();
    await this.runDreamingTask(task, scope);
  }

  override render() {
    const dreaming = this.dreaming;
    const configState = this.context.runtimeConfig.state;
    const configuredDreaming = resolveConfiguredDreaming(currentConfigObject(configState));
    // The status RPC can complete after config switches the engine Off. Keep the
    // cached payload for a future refresh, but never present it as current runtime state.
    const dreamingStatus = configuredDreaming.engineOff ? null : dreaming.dreamingStatus;
    const dreamingOn = dreamingStatus?.enabled ?? configuredDreaming.enabled;
    const loading = dreaming.dreamingStatusLoading || dreaming.dreamingModeSaving;
    const canUpdateConfig = canCallDreamingMethod(dreaming, "config.patch", "operator.admin");
    const defaultState = renderSettingsDefaultState({
      value: t("common.enabled"),
      overridden: configuredDreaming.overridden,
      disabled: loading || !canUpdateConfig,
      onReset: () => void this.resetEnabledOverride(configuredDreaming),
    });
    const refreshLoading = dreaming.dreamingStatusLoading || dreaming.dreamDiaryLoading;
    const selectedAgentId = dreaming.selectedAgentId ?? this.agentId;

    if (this.summaryOnly) {
      const statusTitle = configuredDreaming.engineOff
        ? t("memoryPage.overview.hero.hibernating")
        : dreaming.dreamingStatusError
          ? t("memoryPage.overview.hero.needsAttention")
          : dreaming.dreamingStatusLoading
            ? t("memoryPage.overview.hero.waking")
            : t("memoryPage.overview.hero.awake");
      const statusDescription = configuredDreaming.engineOff
        ? t("memoryPage.overview.hero.offDescription")
        : (dreaming.dreamingStatusError ??
          (dreaming.dreamingStatusLoading
            ? t("memoryPage.overview.hero.loadingDescription")
            : t(dreamingOn ? "dreaming.status.active" : "dreaming.status.idle")));
      return html`<section class="settings-group agent-memory-panel__summary">
        ${renderSettingsRow({
          title: statusTitle,
          description: statusDescription,
          control: html`<button
            class="btn btn--sm"
            ?disabled=${refreshLoading}
            @click=${() => void this.loadAll(true)}
          >
            ${refreshLoading
              ? t("dreaming.header.refreshing")
              : t("memoryPage.overview.hero.refresh")}
          </button>`,
        })}
        ${renderSettingsRow({
          title: t("memoryPage.overview.activity.shortTermCount"),
          control: html`<span class="settings-row__value"
            >${dreamingStatus?.shortTermCount ?? 0}</span
          >`,
        })}
        ${renderSettingsRow({
          title: t("memoryPage.overview.activity.promotedToday"),
          control: html`<span class="settings-row__value"
            >${dreamingStatus?.promotedToday ?? 0}</span
          >`,
        })}
      </section>`;
    }

    return html`
      ${this.surface === "dreaming"
        ? html`<div class="agent-memory-panel__toolbar">
            <div class="dreaming-header-controls">
              <button
                class="btn btn--subtle btn--sm"
                ?disabled=${loading || dreaming.dreamDiaryLoading}
                @click=${() => void this.loadAll(true)}
              >
                ${refreshLoading ? t("dreaming.header.refreshing") : t("dreaming.header.refresh")}
              </button>
              <span class="muted">
                ${configuredDreaming.engineOff
                  ? t("dreaming.header.engineOff")
                  : defaultState.description}
              </span>
              ${defaultState.action}
              <button
                class="dreams__phase-toggle ${dreamingOn ? "dreams__phase-toggle--on" : ""}"
                ?disabled=${!canUpdateConfig || loading || configuredDreaming.engineOff}
                @click=${() => this.setEnabled(!dreamingOn, dreamingOn)}
              >
                <span class="dreams__phase-toggle-dot"></span>
                <span class="dreams__phase-toggle-label">
                  ${dreamingOn ? t("dreaming.header.on") : t("dreaming.header.off")}
                </span>
              </button>
            </div>
          </div>`
        : nothing}
      ${(this.surface === "wiki" ? renderWikiKnowledge : renderDreaming)({
        access: {
          canOpenConfig: canCallDreamingMethod(dreaming, "config.openFile", "operator.admin", {
            requireAdvertisement: false,
          }),
          canBackfillDiary: canCallDreamingMethod(
            dreaming,
            "doctor.memory.backfillDreamDiary",
            "operator.write",
          ),
          canDedupeDreamDiary: canCallDreamingMethod(
            dreaming,
            "doctor.memory.dedupeDreamDiary",
            "operator.write",
          ),
          canResetDiary: canCallDreamingMethod(
            dreaming,
            "doctor.memory.resetDreamDiary",
            "operator.write",
          ),
          canResetGroundedShortTerm: canCallDreamingMethod(
            dreaming,
            "doctor.memory.resetGroundedShortTerm",
            "operator.write",
          ),
          canRepairDreamingArtifacts: canCallDreamingMethod(
            dreaming,
            "doctor.memory.repairDreamingArtifacts",
            "operator.write",
          ),
          canEditWiki: isGatewayMethodAdvertised(dreaming, "wiki.document.save") === true,
        },
        viewState: this.viewState,
        active: dreamingOn,
        selectedAgentId,
        shortTermCount: dreamingStatus?.shortTermCount ?? 0,
        promotedCount: dreamingStatus?.promotedToday ?? 0,
        phases: dreamingStatus?.phases ?? undefined,
        shortTermEntries: dreamingStatus?.shortTermEntries ?? [],
        promotedEntries: dreamingStatus?.promotedEntries ?? [],
        dreamingOf: null,
        nextCycle: resolveDreamingNextCycle(dreamingStatus),
        timezone: dreamingStatus?.timezone ?? null,
        statusError: dreaming.dreamingStatusError,
        modeSaving: dreaming.dreamingModeSaving,
        dreamDiaryLoading: dreaming.dreamDiaryLoading,
        dreamDiaryActionLoading: dreaming.dreamDiaryActionLoading,
        dreamDiaryActionMessage: dreaming.dreamDiaryActionMessage,
        dreamDiaryActionArchivePath: dreaming.dreamDiaryActionArchivePath,
        dreamDiaryError: dreaming.dreamDiaryError,
        dreamDiaryContent: dreaming.dreamDiaryContent,
        memoryWikiEnabled: isMemoryWikiAvailable(dreaming),
        wikiImportInsightsLoading: dreaming.wikiImportInsightsLoading,
        wikiImportInsightsError: dreaming.wikiImportInsightsError,
        wikiImportInsights: dreaming.wikiImportInsights,
        wikiOverviewLoading: dreaming.wikiOverviewLoading,
        wikiOverviewError: dreaming.wikiOverviewError,
        wikiOverview: dreaming.wikiOverview,
        wikiGraphLoading: dreaming.wikiGraphLoading,
        wikiGraphError: dreaming.wikiGraphError,
        wikiGraph: dreaming.wikiGraph,
        wikiGraphRenderer: this.wikiGraphRenderer,
        onRefreshDiary: () => void this.runDreamingTask(loadDreamDiary),
        onRefreshImports: () => void this.refreshWikiData(loadWikiImportInsights),
        onRefreshWikiOverview: () => void this.refreshWikiData(loadWikiOverview),
        onRefreshWikiGraph: () => void this.loadWikiGraphView(),
        onSelectWikiGraph: () => void this.loadWikiGraphView(),
        onOpenConfig: () => void this.context.runtimeConfig.openFile(),
        onOpenWikiPage: (lookup) => this.openWikiPage(lookup),
        onSaveWikiPage: (params) => this.saveWikiPage(params),
        onConfirmWikiDiscard: () =>
          showConfirmDialog({
            title: t("dreaming.wiki.discardTitle"),
            message: t("dreaming.wiki.discardDescription"),
            confirmLabel: t("dreaming.wiki.discard"),
            danger: true,
          }),
        wikiActions: this.wikiActions,
        onBackfillDiary: () => void this.runDreamingTask(backfillDreamDiary),
        onCopyDreamingArchivePath: () => void this.runDreamingTask(copyDreamingArchivePath),
        onDedupeDreamDiary: () =>
          void this.confirmDreamingTask(dedupeDreamDiary, {
            title: t("dreaming.scene.dedupeDiary"),
            message: t("dreaming.actions.confirmDedupeDescription"),
            confirmLabel: t("dreaming.scene.dedupeDiary"),
            danger: true,
          }),
        onResetDiary: () =>
          void this.confirmDreamingTask(resetDreamDiary, {
            title: t("dreaming.scene.reset"),
            message: t("dreaming.actions.confirmResetDiaryDescription"),
            confirmLabel: t("dreaming.scene.reset"),
            danger: true,
          }),
        onResetGroundedShortTerm: () =>
          void this.confirmDreamingTask(resetGroundedShortTerm, {
            title: t("dreaming.scene.clearGrounded"),
            message: t("dreaming.actions.confirmClearGroundedDescription"),
            confirmLabel: t("dreaming.scene.clearGrounded"),
            danger: true,
          }),
        onRepairDreamingArtifacts: () =>
          void this.confirmDreamingTask(repairDreamingArtifacts, {
            title: t("dreaming.scene.repairCache"),
            message: t("dreaming.actions.confirmRepairDescription"),
            confirmLabel: t("dreaming.scene.repairCache"),
          }),
        onViewStateChange: () => this.requestUpdate(),
      })}
      ${renderDreamingToggleConfirmation({
        open: this.toggleConfirmOpen,
        enabling: this.pendingEnabled === true,
        loading: this.toggleConfirmLoading,
        onConfirm: () => void this.confirmToggle(),
        onCancel: () => this.cancelToggle(),
        hasError: Boolean(dreaming.dreamingStatusError),
      })}
    `;
  }
}

if (!customElements.get("openclaw-agent-memory-panel")) {
  customElements.define("openclaw-agent-memory-panel", AgentMemoryPanel);
}
