import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { AgentsListResult, SkillStatusReport } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { searchClawHub, type ClawHubSearchResult } from "../../lib/skills/clawhub-search.ts";
import {
  closeClawHubDetail,
  installFromClawHub,
  installSkill,
  loadClawHubDetail,
  loadSkillCard,
  loadSkills,
  refreshSkills,
  reconcileSkillsAgentId,
  saveSkillApiKey,
  setSkillsAgentId,
  updateSkillEdit,
  updateSkillEnabled,
  type ClawHubSkillDetail,
  type ClawHubSkillSecurityVerdict,
  type SkillOperation,
  type SkillMessageMap,
} from "../../lib/skills/index.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { subscribeToPlatformClawExecutionTargetChanges } from "../../platformclaw/execution-target-events.ts";
import { loadPlatformClawLocale, platformClawT } from "../../platformclaw/i18n.ts";
import {
  loadPlatformClawSkillHubConfig,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubMessage,
} from "../../platformclaw/skill-hub.ts";
import { renderPluginsHubShell } from "../plugins/plugins-hub-shell.ts";
import { SkillHubWorkspacePublishController } from "../skill-hub/workspace-publish-controller.ts";
import { SkillsChangedRefreshQueue } from "./skills-changed-refresh-queue.ts";
import { renderSkills, type SkillDetailTab, type SkillsStatusFilter } from "./view.ts";

export type SkillsRouteData = {
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  agents: ApplicationContext["agents"];
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  report: SkillStatusReport | null;
  error: string | null;
};

class SkillsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: SkillsRouteData;

  @state() skillsAgentId: string | null = null;
  @state() skillsAgentRevision = 0;
  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillOperation: SkillOperation = null;
  @state() skillsFilter = "";
  @state() skillsStatusFilter: SkillsStatusFilter = "all";
  @state() skillEdits: Record<string, string> = {};
  @state() skillMessages: SkillMessageMap = {};
  @state() skillsDetailKey: string | null = null;
  @state() skillsDetailTab: SkillDetailTab = "overview";
  @state() clawhubSearchQuery = "";
  @state() clawhubDetail: ClawHubSkillDetail | null = null;
  @state() clawhubDetailSlug: string | null = null;
  @state() clawhubDetailLoading = false;
  @state() clawhubDetailError: string | null = null;
  @state() clawhubInstallMessage: {
    kind: "success" | "error";
    text: string;
    acknowledgeSlug?: string;
    acknowledgeVersion?: string;
    acknowledgeLabel?: string;
  } | null = null;
  @state() clawhubVerdicts: Record<string, ClawHubSkillSecurityVerdict> = {};
  @state() clawhubVerdictsLoading = false;
  @state() clawhubVerdictsError: string | null = null;
  @state() skillCardContents: Record<string, string> = {};
  @state() skillCardContentKeys: Record<string, string> = {};
  @state() skillCardLoadingKey: string | null = null;
  @state() skillCardErrors: Record<string, string> = {};
  @state() skillHubConfig: PlatformClawSkillHubConfig | null = null;
  @state() skillHubConfigLoading = false;
  @state() skillHubError: string | null = null;
  @state() skillHubMessage: PlatformClawSkillHubMessage | null = null;

  get runtimeConfig(): ApplicationContext["runtimeConfig"] {
    return this.context.runtimeConfig;
  }

  get client() {
    return this.gateway.client;
  }

  get connected() {
    return this.gateway.connected;
  }

  private clawhubSearchTimer: ReturnType<typeof setTimeout> | null = null;
  private routeDataInitialized = false;
  private routeDataEnabled = true;
  private debouncedClawHubSearchQuery = "";
  private readonly skillsChangedRefresh = new SkillsChangedRefreshQueue(
    () => this.connected && !this.skillsLoading && !this.skillOperation,
    () => loadSkills(this, { refresh: true }),
  );
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetLoadedSkillState(),
    ensureInitialData: () => this.ensureInitialData(),
  });
  private readonly clawhubSearchTask = new Task(this, {
    autoRun: false,
    args: () =>
      [
        this.gateway.connected ? this.gateway.client : null,
        this.debouncedClawHubSearchQuery,
      ] as const,
    task: ([client, query], { signal }) =>
      client && query ? searchClawHub(client, query, signal) : initialState,
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const cleanupEvents = gateway.subscribeEvents((event) => {
          if (event.event !== "skills.changed") {
            return;
          }
          this.skillsChangedRefresh.invalidate(
            this.skillsReport !== null || this.skillsError !== null || this.skillsLoading,
          );
        });
        return cleanupEvents;
      },
    )
    .effect(
      () => this.context?.agents,
      (agents) => {
        const cleanup = agents.subscribe(() => {
          this.reconcileAgentState();
          this.requestUpdate();
        });
        this.reconcileAgentState();
        this.ensureInitialData();
        return cleanup;
      },
    )
    .effect(
      () => (this.context?.accessMode === "personal-agent" ? window : undefined),
      (target) =>
        subscribeToPlatformClawExecutionTargetChanges(
          target,
          () => this.resetLoadedSkillState(),
          () => {
            this.ensureInitialData();
            this.requestUpdate();
          },
        ),
    );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
      this.ensureInitialData();
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }

  override updated() {
    this.skillsChangedRefresh.drain();
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
      this.clawhubSearchTimer = null;
    }
    super.disconnectedCallback();
  }

  private reconcileAgentState() {
    const agentState = this.context.agents.state;
    if (agentState.agentsList) {
      const previousAgentId = this.skillsAgentId;
      reconcileSkillsAgentId(this, agentState.agentsList);
      if (previousAgentId !== this.skillsAgentId) {
        this.skillsDetailKey = null;
        this.skillsDetailTab = "overview";
      }
    }
  }

  private resetLoadedSkillState() {
    this.skillsChangedRefresh.reset();
    void this.clawhubSearchTask.run([null, ""]);
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
      this.clawhubSearchTimer = null;
    }
    if (this.routeDataInitialized) {
      this.routeDataEnabled = false;
    }
    this.skillsAgentId = null;
    this.skillsAgentRevision++;
    this.skillsLoading = false;
    this.skillsReport = null;
    this.skillsError = null;
    this.skillOperation = null;
    this.skillEdits = {};
    this.skillMessages = {};
    this.skillsDetailKey = null;
    this.skillsDetailTab = "overview";
    this.debouncedClawHubSearchQuery = "";
    this.clawhubDetail = null;
    this.clawhubDetailSlug = null;
    this.clawhubDetailLoading = false;
    this.clawhubDetailError = null;
    this.clawhubInstallMessage = null;
    this.clawhubVerdicts = {};
    this.clawhubVerdictsLoading = false;
    this.clawhubVerdictsError = null;
    this.skillCardContents = {};
    this.skillCardContentKeys = {};
    this.skillCardLoadingKey = null;
    this.skillCardErrors = {};
    this.skillHubConfig = null;
    this.skillHubConfigLoading = false;
    this.skillHubError = null;
    this.skillHubMessage = null;
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataInitialized = true;
    this.routeDataEnabled = true;
    if (!this.gateway.isRouteDataCurrent(data) || data.agents !== this.context.agents) {
      this.routeDataEnabled = false;
      return;
    }
    if (this.skillsAgentId && data.selectedAgentId && data.selectedAgentId !== this.skillsAgentId) {
      return;
    }
    this.skillsAgentId = data.selectedAgentId ?? this.skillsAgentId;
    this.skillsLoading = false;
    this.skillsReport = data.report;
    this.skillsError = data.error;
  }

  private ensureInitialData() {
    if (!this.gateway.connected || !this.gateway.client) {
      return;
    }
    // Route preloading supplies workspace status, but not product-owned Hub settings.
    if (
      this.canUseSkillHub() &&
      !this.skillHubConfig &&
      !this.skillHubConfigLoading &&
      !this.skillHubError
    ) {
      void this.loadSkillHubConfig();
    }
    if (
      this.routeDataEnabled &&
      (this.routeData?.agentsList || this.routeData?.report || this.routeData?.error)
    ) {
      return;
    }
    const agents = this.context.agents.state;
    if (!agents.agentsList && !agents.agentsLoading) {
      void this.loadAgents();
    }
    if (!this.skillsReport && !this.skillsLoading) {
      void loadSkills(this);
    }
    if (
      this.clawhubSearchQuery.trim() &&
      this.clawhubSearchTask.status !== TaskStatus.PENDING &&
      this.clawhubSearchResults === null &&
      this.clawhubSearchError === null
    ) {
      this.runClawHubSearch(this.clawhubSearchQuery);
    }
  }

  private async loadAgents() {
    if (!this.gateway.client || !this.gateway.connected) {
      return;
    }
    const agentsSource = this.context.agents;
    if (!agentsSource.state.agentsList) {
      await agentsSource.ensureList();
    }
    if (this.context.agents === agentsSource) {
      this.reconcileAgentState();
    }
  }

  private async refreshPage() {
    await refreshSkills(this, () => this.loadAgents());
    if (this.canUseSkillHub()) {
      await this.loadSkillHubConfig();
    }
  }

  private changeAgent(agentId: string) {
    if (this.skillOperation || this.skillsLoading) {
      return;
    }
    const previousAgentId = this.skillsAgentId;
    setSkillsAgentId(this, agentId);
    if (previousAgentId !== this.skillsAgentId) {
      this.skillsDetailKey = null;
      this.skillsDetailTab = "overview";
    }
    void loadSkills(this, { clearMessages: true });
  }

  private changeClawHubQuery(query: string) {
    this.clawhubSearchQuery = query;
    this.clawhubInstallMessage = null;
    this.debouncedClawHubSearchQuery = "";
    void this.clawhubSearchTask.run([null, ""]);
    if (this.clawhubSearchTimer) {
      clearTimeout(this.clawhubSearchTimer);
    }
    this.clawhubSearchTimer = setTimeout(() => this.runClawHubSearch(query), 300);
  }

  private runClawHubSearch(query: string) {
    const normalizedQuery = query.trim();
    this.debouncedClawHubSearchQuery = normalizedQuery;
    if (!normalizedQuery || !this.gateway.connected || !this.gateway.client) {
      void this.clawhubSearchTask.run([null, ""]);
      return;
    }
    void this.clawhubSearchTask.run([this.gateway.client, normalizedQuery]);
  }

  get clawhubSearchResults(): ClawHubSearchResult[] | null {
    return this.clawhubSearchTask.status === TaskStatus.COMPLETE &&
      this.debouncedClawHubSearchQuery === this.clawhubSearchQuery.trim()
      ? (this.clawhubSearchTask.value ?? null)
      : null;
  }

  get clawhubSearchLoading(): boolean {
    return (
      this.debouncedClawHubSearchQuery.length > 0 &&
      this.clawhubSearchTask.status === TaskStatus.PENDING
    );
  }

  get clawhubSearchError(): string | null {
    if (
      this.clawhubSearchTask.status !== TaskStatus.ERROR ||
      this.debouncedClawHubSearchQuery !== this.clawhubSearchQuery.trim()
    ) {
      return null;
    }
    const error = this.clawhubSearchTask.error;
    return error instanceof Error ? error.message : String(error);
  }

  private changeDetailTab(tab: SkillDetailTab) {
    this.skillsDetailTab = tab;
    if (tab === "card" && this.skillsDetailKey) {
      void loadSkillCard(this, this.skillsDetailKey);
    }
  }

  private canUpdateSkills(): boolean {
    return canCallGatewayMethod(this.context?.gateway?.snapshot, "skills.update", "operator.admin");
  }

  private canInstallSkills(): boolean {
    return canCallGatewayMethod(
      this.context?.gateway?.snapshot,
      "skills.install",
      "operator.admin",
    );
  }

  private canUseSkillHub(): boolean {
    return (
      this.context.accessMode === "personal-agent" &&
      this.context.isRouteEnabled?.("skill-hub") !== false
    );
  }

  private async loadSkillHubConfig(): Promise<Result<undefined, string>> {
    this.skillHubConfigLoading = true;
    this.skillHubError = null;
    try {
      this.skillHubConfig = await loadPlatformClawSkillHubConfig();
    } catch (error) {
      this.skillHubError = error instanceof Error ? error.message : String(error);
      return err(this.skillHubError);
    } finally {
      this.skillHubConfigLoading = false;
    }
    return ok(undefined);
  }

  private readonly skillHubPublish = new SkillHubWorkspacePublishController(this, {
    refresh: async () => {
      const result = await this.loadSkillHubConfig();
      if (!result.ok) {
        throw new Error(result.error);
      }
    },
    setMessage: (message) => (this.skillHubMessage = message),
  });

  private openSkillHubPublish(skill: string) {
    if (!this.canUseSkillHub() || !this.skillHubConfig) {
      return;
    }
    const source =
      this.skillsReport?.executionTarget === "assigned_vm" ? "assigned_vm" : "platform_server";
    void this.skillHubPublish.openDialog(this.skillHubConfig, undefined, { skill, source });
  }

  override render() {
    const agents = this.context.agents.state;
    const error = this.skillsError ?? agents.agentsError;
    return renderPluginsHubShell({
      header: html`<section class="content-header content-header--page plugins-content-header">
        <div>
          <h1 class="page-title">${titleForRoute("skills")}</h1>
          ${this.context.renderPageHeaderAccessory?.("skills")}
        </div>
      </section>`,
      content: renderSettingsWorkspace(html`
        ${renderSkills({
          personalAccess: this.context.accessMode === "personal-agent",
          canUpdate: this.canUpdateSkills(),
          canInstall: this.canInstallSkills(),
          connected: this.gateway.connected,
          loading: this.skillsLoading || agents.agentsLoading,
          report: this.skillsReport,
          agentsList: agents.agentsList,
          selectedAgentId: this.skillsAgentId ?? agents.agentsList?.defaultId ?? null,
          error,
          filter: this.skillsFilter,
          statusFilter: this.skillsStatusFilter,
          edits: this.skillEdits,
          messages: this.skillMessages,
          operation: this.skillOperation,
          detailKey: this.skillsDetailKey,
          detailTab: this.skillsDetailTab,
          clawhubVerdicts: this.clawhubVerdicts,
          clawhubVerdictsLoading: this.clawhubVerdictsLoading,
          clawhubVerdictsError: this.clawhubVerdictsError,
          skillCardContents: this.skillCardContents,
          skillCardLoadingKey: this.skillCardLoadingKey,
          skillCardErrors: this.skillCardErrors,
          clawhubQuery: this.clawhubSearchQuery,
          clawhubResults: this.clawhubSearchResults,
          clawhubSearchLoading: this.clawhubSearchLoading,
          clawhubSearchError: this.clawhubSearchError,
          clawhubDetail: this.clawhubDetail,
          clawhubDetailSlug: this.clawhubDetailSlug,
          clawhubDetailLoading: this.clawhubDetailLoading,
          clawhubDetailError: this.clawhubDetailError,
          clawhubInstallMessage: this.clawhubInstallMessage,
          skillHubConfig: this.canUseSkillHub() ? this.skillHubConfig : null,
          skillHubMessage:
            this.skillHubMessage ??
            (this.canUseSkillHub() && this.skillHubError
              ? {
                  kind: "error",
                  text: platformClawT("platformClaw.skillHub.configLoadFailed", {
                    error: this.skillHubError,
                  }),
                }
              : null),
          onAgentChange: (agentId) => this.changeAgent(agentId),
          onFilterChange: (next) => (this.skillsFilter = next),
          onStatusFilterChange: (next) => (this.skillsStatusFilter = next),
          onRefresh: () => void this.refreshPage(),
          onBrowseSkillHub: this.canUseSkillHub()
            ? () => this.context.navigate("skill-hub")
            : undefined,
          onToggle: (key, enabled) => {
            if (this.canUpdateSkills()) {
              void updateSkillEnabled(this, key, enabled, () => this.canUpdateSkills());
            }
          },
          onEdit: (key, value) => {
            if (this.canUpdateSkills()) {
              updateSkillEdit(this, key, value);
            }
          },
          onSaveKey: (key) => {
            if (this.canUpdateSkills()) {
              void saveSkillApiKey(this, key, () => this.canUpdateSkills());
            }
          },
          onInstall: (skillKey, name, installId) => {
            if (this.canInstallSkills()) {
              void installSkill(this, skillKey, name, installId);
            }
          },
          onDetailOpen: (key) => {
            this.skillsDetailKey = key;
            this.skillsDetailTab = "overview";
          },
          onDetailClose: () => (this.skillsDetailKey = null),
          onDetailTabChange: (tab) => this.changeDetailTab(tab),
          onClawHubQueryChange: (query) => this.changeClawHubQuery(query),
          onClawHubDetailOpen: (slug) => void loadClawHubDetail(this, slug),
          onClawHubDetailClose: () => closeClawHubDetail(this),
          onClawHubInstall: (slug, acknowledgeClawHubRisk, version) => {
            if (this.canInstallSkills()) {
              void installFromClawHub(this, slug, acknowledgeClawHubRisk, version);
            }
          },
          onSkillHubPublishOpen: (skill) => this.openSkillHubPublish(skill),
        })}
        ${this.skillHubPublish.renderDialog(this.skillHubConfig)}
      `),
    });
  }
}

if (!customElements.get("openclaw-skills-page")) {
  customElements.define("openclaw-skills-page", SkillsPage);
}
