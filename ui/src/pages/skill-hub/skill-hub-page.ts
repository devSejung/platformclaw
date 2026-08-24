import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  installPlatformClawHubSkill,
  forcePublishPlatformClawHubSkill,
  grantPlatformClawSkillHubAccess,
  loadPlatformClawSkillHubConfig,
  loadPlatformClawSkillHubDetail,
  loadPlatformClawSkillHubNamespaceBindings,
  loadPlatformClawSkillHubNotifications,
  loadPlatformClawSkillHubUnassignedSkills,
  markPlatformClawSkillHubNotificationsRead,
  publishPlatformClawSkillArchive,
  removePlatformClawSkillHubAccess,
  removePlatformClawSkillHubNamespaceBinding,
  searchPlatformClawSkillHub,
  setPlatformClawSkillHubNamespaceBinding,
  transferPlatformClawSkillHubOwner,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubDetail,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubNamespaceBinding,
  type PlatformClawSkillHubNotification,
  type PlatformClawSkillHubSearchItem,
  type PlatformClawSkillHubUnassignedSkill,
  type PlatformClawManagedScope,
  PlatformClawSkillHubRequestError,
} from "../../platformclaw/skill-hub.ts";
import "../../styles/plugins.css";
import "../../styles/skill-hub.css";
import { renderPluginsHubShell } from "../plugins/plugins-hub-shell.ts";
import {
  PLUGINS_HUB_PANEL_ID,
  routeForPluginsHubTab,
  type PluginsHubTab,
} from "../plugins/plugins-hub.ts";
import { renderSkillHubAdmin, type SkillHubAdminDraft } from "./admin.ts";
import {
  renderSkillHubNotifications,
  renderSkillHubUpload,
  renderSkillHubVersionChange,
} from "./dialogs.ts";
import {
  skillHubScannerStatusLabel,
  skillHubSkillStatusLabel,
  skillHubVersionStatusLabel,
  skillHubVisibilityLabel,
} from "./labels.ts";
import { renderSkillHubManagement } from "./management.ts";

type SkillHubRef = { namespace: string; slug: string };
type InstallTarget = "platform_server" | "assigned_vm";
type PendingVersionChange = {
  target: InstallTarget;
  currentVersion: string;
  requestedVersion: string;
  direction: "upgrade" | "downgrade";
};

function readInitialQuery(): string {
  return new URL(window.location.href).searchParams.get("q")?.trim() ?? "";
}

function versionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

class SkillHubPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private config: PlatformClawSkillHubConfig | null = null;
  @state() private query = readInitialQuery();
  @state() private results: PlatformClawSkillHubSearchItem[] | null = null;
  @state() private total = 0;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private detailRef: SkillHubRef | null = null;
  @state() private detail: PlatformClawSkillHubDetail | null = null;
  @state() private detailLoading = false;
  @state() private selectedVersion = "";
  @state() private installing: InstallTarget | null = null;
  @state() private message: PlatformClawSkillHubMessage | null = null;
  @state() private notificationsOpen = false;
  @state() private notificationsLoading = false;
  @state() private notifications: PlatformClawSkillHubNotification[] = [];
  @state() private uploadOpen = false;
  @state() private uploadFile: File | null = null;
  @state() private uploadSlug = "";
  @state() private uploadNamespace = "";
  @state() private uploadVersion = "1.0.0";
  @state() private uploadVisibility = "NAMESPACE_ONLY";
  @state() private uploading = false;
  @state() private managementBusy = false;
  @state() private ownerUserId = "";
  @state() private accessUserId = "";
  @state() private forceReason = "";
  @state() private forceAcknowledged = false;
  @state() private adminOpen = false;
  @state() private adminLoading = false;
  @state() private adminBusy = false;
  @state() private namespaceBindings: PlatformClawSkillHubNamespaceBinding[] = [];
  @state() private managedScopes: PlatformClawManagedScope[] = [];
  @state() private unassignedSkills: PlatformClawSkillHubUnassignedSkill[] = [];
  @state() private adminDraft: SkillHubAdminDraft = {
    namespace: "",
    scopeKind: "global",
    scopeId: "",
    visibilityCeiling: "NAMESPACE_ONLY",
  };
  @state() private pendingVersionChange: PendingVersionChange | null = null;

  override connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    this.loading = true;
    this.error = null;
    try {
      this.config = await loadPlatformClawSkillHubConfig();
      this.uploadNamespace = this.config.namespaces[0] ?? "";
      await this.search();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  private async openNotifications() {
    this.notificationsOpen = true;
    this.notificationsLoading = true;
    try {
      const result = await loadPlatformClawSkillHubNotifications();
      this.notifications = result.items;
      if (this.config?.notifications) {
        this.config = { ...this.config, notifications: { unreadCount: result.unreadCount } };
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.notificationsLoading = false;
    }
  }

  private async markAllNotificationsRead() {
    this.notificationsLoading = true;
    try {
      await markPlatformClawSkillHubNotificationsRead();
      this.notifications = this.notifications.map((item) => ({
        ...item,
        readAt: item.readAt ?? Date.now(),
      }));
      if (this.config?.notifications) {
        this.config = { ...this.config, notifications: { unreadCount: 0 } };
      }
    } finally {
      this.notificationsLoading = false;
    }
  }

  private async openAdmin() {
    this.adminOpen = true;
    this.adminLoading = true;
    try {
      const [namespaceResult, unassignedResult] = await Promise.all([
        loadPlatformClawSkillHubNamespaceBindings(),
        loadPlatformClawSkillHubUnassignedSkills(),
      ]);
      this.namespaceBindings = namespaceResult.bindings;
      this.managedScopes = namespaceResult.scopes;
      this.unassignedSkills = unassignedResult.items;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.adminLoading = false;
    }
  }

  private async saveNamespaceBinding() {
    if (this.adminBusy) {
      return;
    }
    this.adminBusy = true;
    try {
      await setPlatformClawSkillHubNamespaceBinding({
        namespace: this.adminDraft.namespace,
        scopeKind: this.adminDraft.scopeKind,
        ...(this.adminDraft.scopeKind === "global" ? {} : { scopeId: this.adminDraft.scopeId }),
        visibilityCeiling: this.adminDraft.visibilityCeiling,
      });
      await this.openAdmin();
      this.message = { kind: "success", text: t("skillHubPage.bindingSaved") };
    } catch (error) {
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.adminBusy = false;
    }
  }

  private async removeNamespaceBinding(namespace: string) {
    if (this.adminBusy) {
      return;
    }
    this.adminBusy = true;
    try {
      await removePlatformClawSkillHubNamespaceBinding(namespace);
      await this.openAdmin();
      this.message = { kind: "success", text: t("skillHubPage.bindingRemoved") };
    } catch (error) {
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.adminBusy = false;
    }
  }

  private async publishZip() {
    if (!this.uploadFile || this.uploading) {
      return;
    }
    this.uploading = true;
    this.message = null;
    try {
      const result = await publishPlatformClawSkillArchive(this.uploadFile, {
        slug: this.uploadSlug,
        namespace: this.uploadNamespace,
        version: this.uploadVersion,
        visibility: this.uploadVisibility,
      });
      this.message = {
        kind: "success",
        text: t("skillHubPage.publishedZip", {
          skill: `${result.namespace}/${result.slug}@${result.version}`,
        }),
      };
      this.uploadOpen = false;
      await this.search();
    } catch (error) {
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.uploading = false;
    }
  }

  private async search() {
    this.loading = true;
    this.error = null;
    this.message = null;
    try {
      const result = await searchPlatformClawSkillHub(this.query.trim());
      this.results = result.items;
      this.total = result.total;
      const url = new URL(window.location.href);
      if (this.query.trim()) {
        url.searchParams.set("q", this.query.trim());
      } else {
        url.searchParams.delete("q");
      }
      window.history.replaceState(window.history.state, "", url);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  private async openDetail(ref: SkillHubRef) {
    this.detailRef = { namespace: ref.namespace, slug: ref.slug };
    this.detail = null;
    this.detailLoading = true;
    this.message = null;
    try {
      this.detail = await loadPlatformClawSkillHubDetail(ref.namespace, ref.slug);
      this.selectedVersion =
        this.detail.versions.find((version) => version.downloadAvailable)?.version ?? "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.detailLoading = false;
    }
  }

  private async install(target: InstallTarget, versionChange?: PendingVersionChange) {
    if (!this.detailRef || !this.selectedVersion || this.installing) {
      return;
    }
    this.installing = target;
    this.message = null;
    try {
      const result = await installPlatformClawHubSkill({
        ...this.detailRef,
        version: this.selectedVersion,
        destination: target,
        ...(versionChange
          ? {
              acknowledgedVersionChange: true as const,
              currentVersion: versionChange.currentVersion,
            }
          : {}),
      });
      this.pendingVersionChange = null;
      this.message = {
        kind: "success",
        text: result.noOp
          ? t("skillHubPage.alreadyInstalled", { skill: `${result.slug}@${result.version}` })
          : t("skillHubPage.installed", {
              skill: `${result.slug}@${result.version}`,
              target: t(
                target === "assigned_vm"
                  ? "platformClaw.execution.vm"
                  : "platformClaw.execution.basic",
              ),
            }),
      };
    } catch (error) {
      if (
        error instanceof PlatformClawSkillHubRequestError &&
        error.details?.code === "version-change-required" &&
        typeof error.details.currentVersion === "string" &&
        typeof error.details.requestedVersion === "string" &&
        (error.details.direction === "upgrade" || error.details.direction === "downgrade")
      ) {
        this.pendingVersionChange = {
          target,
          currentVersion: error.details.currentVersion,
          requestedVersion: error.details.requestedVersion,
          direction: error.details.direction,
        };
        return;
      }
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.installing = null;
    }
  }

  private async runManagement(operation: () => Promise<unknown>, success: string) {
    if (!this.detailRef || this.managementBusy) {
      return;
    }
    this.managementBusy = true;
    try {
      await operation();
      const ref = this.detailRef;
      await this.openDetail(ref);
      this.message = { kind: "success", text: success };
    } catch (error) {
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.managementBusy = false;
    }
  }

  private selectHubTab(tab: PluginsHubTab) {
    const route = routeForPluginsHubTab(tab);
    if (route) {
      this.context.navigate(route);
    }
  }

  private renderCard(item: PlatformClawSkillHubSearchItem) {
    return html`<button class="skill-hub-card" type="button" @click=${() => this.openDetail(item)}>
      <span class="skill-hub-card__namespace">${item.namespace}</span>
      <strong class="skill-hub-card__name">${item.slug}</strong>
      <span class="skill-hub-card__summary">${item.summary}</span>
      <span class="skill-hub-card__meta">
        <span>${versionLabel(item.latestVersion)}</span>
        <span>${t("skillHubPage.viewDetails")}</span>
      </span>
    </button>`;
  }

  private renderDetail() {
    if (!this.detailRef) {
      return nothing;
    }
    const skill = this.detail?.skill;
    const basic = this.config?.installTargets?.find(
      (target) => target.target === "platform_server",
    );
    const vm = this.config?.installTargets?.find((target) => target.target === "assigned_vm");
    return html`<openclaw-modal-dialog
      label=${skill?.displayName ?? this.detailRef.slug}
      @modal-cancel=${() => (this.detailRef = null)}
    >
      <article class="skill-hub-detail">
        <header class="skill-hub-detail__header">
          <div>
            <span class="skill-hub-card__namespace">${this.detailRef.namespace}</span>
            <h2>${skill?.displayName ?? this.detailRef.slug}</h2>
            ${skill?.summary ? html`<p>${skill.summary}</p>` : nothing}
          </div>
          <button class="btn btn--sm" @click=${() => (this.detailRef = null)}>
            ${t("skillsPage.close")}
          </button>
        </header>
        ${this.detailLoading
          ? html`<div class="skill-hub-state">${t("skillsPage.skillHub.loading")}</div>`
          : html`
              <div class="skill-hub-badges">
                <span class="skill-hub-badge">${skillHubVisibilityLabel(skill?.visibility)}</span>
                <span class="skill-hub-badge">${skillHubSkillStatusLabel(skill?.status)}</span>
                ${this.detail?.scanner
                  ? html`<span class="skill-hub-badge is-${this.detail.scanner.status}">
                      ${skillHubScannerStatusLabel(this.detail.scanner.status)}
                    </span>`
                  : nothing}
              </div>
              <section class="skill-hub-versions">
                <h3>${t("skillHubPage.versions")}</h3>
                ${this.detail?.versions.map(
                  (version) => html`<label class="skill-hub-version">
                    <input
                      type="radio"
                      name="skill-hub-version"
                      value=${version.version}
                      .checked=${this.selectedVersion === version.version}
                      ?disabled=${!version.downloadAvailable}
                      @change=${() => (this.selectedVersion = version.version)}
                    />
                    <span>
                      <strong>${versionLabel(version.version)}</strong>
                      <small
                        >${version.changelog ?? skillHubVersionStatusLabel(version.status)}</small
                      >
                    </span>
                    <span class="skill-hub-version__size"
                      >${version.totalSize ? `${Math.ceil(version.totalSize / 1024)} KB` : ""}</span
                    >
                  </label>`,
                )}
              </section>
              <div class="skill-hub-install-actions">
                <button
                  class="btn primary"
                  ?disabled=${!this.selectedVersion ||
                  this.installing !== null ||
                  basic?.available === false}
                  title=${basic?.disabledReason ?? ""}
                  @click=${() => this.install("platform_server")}
                >
                  ${this.installing === "platform_server"
                    ? t("skillsPage.skillHub.installing")
                    : t("skillHubPage.installBasic")}
                </button>
                <button
                  class="btn"
                  ?disabled=${!this.selectedVersion ||
                  this.installing !== null ||
                  vm?.available === false}
                  title=${vm?.disabledReason ?? ""}
                  @click=${() => this.install("assigned_vm")}
                >
                  ${this.installing === "assigned_vm"
                    ? t("skillsPage.skillHub.installing")
                    : t("skillHubPage.installVm")}
                </button>
              </div>
              ${renderSkillHubManagement({
                detail: this.detail,
                ownerUserId: this.ownerUserId,
                accessUserId: this.accessUserId,
                forceReason: this.forceReason,
                forceAcknowledged: this.forceAcknowledged,
                busy: this.managementBusy,
                onOwnerUserId: (value) => (this.ownerUserId = value),
                onTransferOwner: () => {
                  void this.runManagement(
                    () =>
                      transferPlatformClawSkillHubOwner(
                        this.detailRef!.namespace,
                        this.detailRef!.slug,
                        this.ownerUserId,
                      ),
                    t("skillHubPage.ownerTransferred"),
                  );
                },
                onAccessUserId: (value) => (this.accessUserId = value),
                onGrantAccess: () => {
                  void this.runManagement(
                    () =>
                      grantPlatformClawSkillHubAccess(
                        this.detailRef!.namespace,
                        this.detailRef!.slug,
                        { userId: this.accessUserId, inheritVersions: true },
                      ),
                    t("skillHubPage.accessGranted"),
                  );
                },
                onRemoveAccess: (userId) => {
                  void this.runManagement(
                    () =>
                      removePlatformClawSkillHubAccess(
                        this.detailRef!.namespace,
                        this.detailRef!.slug,
                        userId,
                      ),
                    t("skillHubPage.accessRevoked"),
                  );
                },
                onForceReason: (value) => (this.forceReason = value),
                onForceAcknowledged: (value) => (this.forceAcknowledged = value),
                onForcePublish: () => {
                  void this.runManagement(
                    () =>
                      forcePublishPlatformClawHubSkill(
                        this.detailRef!.namespace,
                        this.detailRef!.slug,
                        {
                          version: this.selectedVersion,
                          acknowledged: true,
                          reason: this.forceReason,
                        },
                      ),
                    t("skillHubPage.forcePublished"),
                  );
                },
              })}
              ${this.message
                ? html`<div class="callout ${this.message.kind === "error" ? "danger" : "success"}">
                    ${this.message.text}
                  </div>`
                : nothing}
            `}
      </article>
    </openclaw-modal-dialog>`;
  }

  override render() {
    return renderPluginsHubShell({
      context: this.context,
      active: "skill-hub",
      className: "content--skill-hub",
      header: html`<section class="content-header content-header--page plugins-content-header">
        <div>
          <h1 class="page-title">${t("tabs.skillHub")}</h1>
          <div class="page-subtitle">${t("subtitles.skillHub")}</div>
        </div>
        <div class="skill-hub-header-actions">
          ${this.config?.admin
            ? html`<button class="btn" @click=${() => this.openAdmin()}>
                ${t("skillHubPage.admin")}
                ${this.config.unassignedOwnerCount
                  ? html`<span class="settings-count">${this.config.unassignedOwnerCount}</span>`
                  : nothing}
              </button>`
            : nothing}
          <button class="btn" @click=${() => (this.uploadOpen = true)}>
            ${t("skillHubPage.uploadZip")}
          </button>
          <button
            class="btn"
            title=${t("skillHubPage.notificationsTitle")}
            @click=${() => this.openNotifications()}
          >
            ${t("skillHubPage.notifications")}
            ${this.config?.notifications?.unreadCount
              ? html`<span class="settings-count">${this.config.notifications.unreadCount}</span>`
              : nothing}
          </button>
        </div>
      </section>`,
      content: html`<wa-tab-panel
          id=${PLUGINS_HUB_PANEL_ID}
          name="skill-hub"
          active
          aria-labelledby="plugins-tab-skill-hub"
        >
          <main class="skill-hub-page">
            <section class="skill-hub-hero">
              <div>
                <span class="skill-hub-eyebrow">${t("skillHubPage.companyRegistry")}</span>
                <h2>${t("skillHubPage.heroTitle")}</h2>
                <p>${t("skillHubPage.heroDescription")}</p>
                ${this.config
                  ? html`<p class="skill-hub-registry-status">
                      ${t("skillHubPage.namespacesAvailable", {
                        count: String(this.config.namespaces.length),
                      })}
                    </p>`
                  : nothing}
              </div>
              <div class="skill-hub-search">
                <input
                  class="settings-input"
                  .value=${this.query}
                  placeholder=${t("skillsPage.skillHub.searchPlaceholder")}
                  @input=${(event: Event) =>
                    (this.query = (event.target as HTMLInputElement).value)}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key === "Enter") {
                      void this.search();
                    }
                  }}
                />
                <button class="btn primary" ?disabled=${this.loading} @click=${() => this.search()}>
                  ${this.loading
                    ? t("skillsPage.skillHub.searching")
                    : t("skillsPage.skillHub.search")}
                </button>
              </div>
            </section>
            ${this.error ? html`<div class="callout danger">${this.error}</div>` : nothing}
            ${this.message
              ? html`<div class="callout ${this.message.kind === "error" ? "danger" : "success"}">
                  ${this.message.text}
                </div>`
              : nothing}
            <section class="skill-hub-results" aria-busy=${this.loading ? "true" : "false"}>
              <header>
                <h2>${t("skillHubPage.catalog")}</h2>
                <span>${t("skillHubPage.resultCount", { count: String(this.total) })}</span>
              </header>
              ${this.loading && !this.results
                ? html`<div class="skill-hub-state">${t("skillsPage.skillHub.loading")}</div>`
                : this.results?.length
                  ? html`<div class="skill-hub-grid">
                      ${this.results.map((item) => this.renderCard(item))}
                    </div>`
                  : html`<div class="skill-hub-state">${t("skillsPage.skillHub.noResults")}</div>`}
            </section>
          </main>
        </wa-tab-panel>
        ${this.renderDetail()}
        ${renderSkillHubNotifications({
          open: this.notificationsOpen,
          loading: this.notificationsLoading,
          items: this.notifications,
          onClose: () => (this.notificationsOpen = false),
          onMarkAllRead: () => void this.markAllNotificationsRead(),
        })}
        ${renderSkillHubUpload({
          open: this.uploadOpen,
          config: this.config,
          file: this.uploadFile,
          slug: this.uploadSlug,
          namespace: this.uploadNamespace,
          version: this.uploadVersion,
          visibility: this.uploadVisibility,
          busy: this.uploading,
          onClose: () => (this.uploadOpen = false),
          onFile: (file) => (this.uploadFile = file),
          onSlug: (value) => (this.uploadSlug = value),
          onNamespace: (value) => (this.uploadNamespace = value),
          onVersion: (value) => (this.uploadVersion = value),
          onVisibility: (value) => (this.uploadVisibility = value),
          onPublish: () => void this.publishZip(),
        })}
        ${renderSkillHubAdmin({
          open: this.adminOpen,
          loading: this.adminLoading,
          busy: this.adminBusy,
          bindings: this.namespaceBindings,
          scopes: this.managedScopes,
          unassigned: this.unassignedSkills,
          draft: this.adminDraft,
          onClose: () => (this.adminOpen = false),
          onDraft: (draft) => (this.adminDraft = draft),
          onSave: () => void this.saveNamespaceBinding(),
          onRemove: (namespace) => void this.removeNamespaceBinding(namespace),
        })}
        ${renderSkillHubVersionChange({
          open: this.pendingVersionChange !== null,
          currentVersion: this.pendingVersionChange?.currentVersion ?? "",
          requestedVersion: this.pendingVersionChange?.requestedVersion ?? "",
          direction: this.pendingVersionChange?.direction ?? "upgrade",
          busy: this.installing !== null,
          onClose: () => (this.pendingVersionChange = null),
          onConfirm: () => {
            if (this.pendingVersionChange) {
              void this.install(this.pendingVersionChange.target, this.pendingVersionChange);
            }
          },
        })}`,
      onSelect: (tab) => this.selectHubTab(tab),
    });
  }
}

customElements.define("openclaw-skill-hub-page", SkillHubPage);
