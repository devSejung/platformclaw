import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import "../../components/modal-dialog.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { t } from "../../i18n/index.ts";
import {
  forcePublishPlatformClawHubSkill,
  grantPlatformClawSkillHubAccess,
  loadPlatformClawSkillHubConfig,
  loadPlatformClawSkillHubDetail,
  loadPlatformClawSkillHubNotifications,
  markPlatformClawSkillHubNotificationsRead,
  removePlatformClawSkillHubAccess,
  searchPlatformClawSkillHub,
  transferPlatformClawSkillHubOwner,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubDetail,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubNotification,
  type PlatformClawSkillHubSearchItem,
} from "../../platformclaw/skill-hub.ts";
import "../../styles/plugins.css";
import "../../styles/skill-hub.css";
import { renderPluginsHubShell } from "../plugins/plugins-hub-shell.ts";
import { SkillHubAdminController } from "./admin-controller.ts";
import { renderSkillHubAdmin } from "./admin.ts";
import { SkillHubDeleteController } from "./delete-controller.ts";
import { renderSkillHubNotifications } from "./dialogs.ts";
import { SkillHubEditController } from "./edit-controller.ts";
import { SkillHubInstallController } from "./install-controller.ts";
import {
  skillHubScannerStatusLabel,
  skillHubSkillStatusLabel,
  skillHubVersionStatusLabel,
  skillHubVisibilityLabel,
} from "./labels.ts";
import { renderSkillHubManagement } from "./management.ts";
import * as pageSupport from "./page-support.ts";
import { SkillHubUploadController } from "./upload-controller.ts";
import { SkillHubWorkspacePublishController } from "./workspace-publish-controller.ts";

class SkillHubPage extends SkillHubAdminController {
  @state() private config: PlatformClawSkillHubConfig | null = null;
  @state() private query = pageSupport.readSkillHubInitialQuery(window.location.href);
  @state() private results: PlatformClawSkillHubSearchItem[] | null = null;
  @state() private total = 0;
  @state() private loading = true;
  @state() private detailRef: pageSupport.SkillHubRef | null = null;
  @state() private detail: PlatformClawSkillHubDetail | null = null;
  @state() private detailLoading = false;
  @state() private detailError: string | null = null;
  @state() private selectedVersion = "";
  @state() private notificationsOpen = false;
  @state() private notificationsLoading = false;
  @state() private notificationsError: string | null = null;
  @state() private notifications: PlatformClawSkillHubNotification[] = [];
  @state() private managementBusy = false;
  @state() private ownerUserId = "";
  @state() private accessUserId = "";
  @state() private forceReason = "";
  @state() private forceAcknowledged = false;
  private detailGeneration = 0;
  private readonly skillInstall = new SkillHubInstallController(
    this,
    (message) => (this.message = message),
  );
  private readonly workspacePublish = new SkillHubWorkspacePublishController(this, {
    refresh: () => this.search(),
    setMessage: (message) => (this.message = message),
  });
  private readonly skillDelete = new SkillHubDeleteController(this, {
    refresh: () => this.search(),
    closeDetail: () => this.closeDetail(),
    setMessage: (message) => (this.message = message),
  });
  private readonly skillEdit = new SkillHubEditController(this, {
    refresh: async (ref) => {
      await this.search();
      await this.openDetail(ref);
    },
    setMessage: (message) => (this.message = message),
  });
  private readonly skillUpload = new SkillHubUploadController(this, {
    refresh: async (ref) => {
      await this.search();
      if (ref) {
        await this.openDetail(ref);
      }
    },
    setMessage: (message) => (this.message = message),
  });

  override connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    this.loading = true;
    this.error = null;
    try {
      this.config = await loadPlatformClawSkillHubConfig();
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
    this.notificationsError = null;
    try {
      const result = await loadPlatformClawSkillHubNotifications();
      this.notifications = result.items;
      if (this.config?.notifications) {
        this.config = { ...this.config, notifications: { unreadCount: result.unreadCount } };
      }
    } catch (error) {
      this.notificationsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.notificationsLoading = false;
    }
  }

  private async markAllNotificationsRead() {
    this.notificationsLoading = true;
    this.notificationsError = null;
    try {
      await markPlatformClawSkillHubNotificationsRead();
      this.notifications = this.notifications.map((item) => ({
        ...item,
        readAt: item.readAt ?? Date.now(),
      }));
      if (this.config?.notifications) {
        this.config = { ...this.config, notifications: { unreadCount: 0 } };
      }
    } catch (error) {
      this.notificationsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.notificationsLoading = false;
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

  private async openDetail(ref: pageSupport.SkillHubRef) {
    const generation = ++this.detailGeneration;
    this.skillInstall.clear();
    this.resetManagementSelection();
    this.detailError = null;
    this.detailRef = { namespace: ref.namespace, slug: ref.slug };
    this.detail = null;
    this.selectedVersion = "";
    this.detailLoading = true;
    this.message = null;
    try {
      const detail = await loadPlatformClawSkillHubDetail(ref.namespace, ref.slug);
      if (generation !== this.detailGeneration) {
        return;
      }
      this.detail = detail;
      this.skillInstall.open(ref, this.config);
      this.selectedVersion =
        this.detail.versions.find((version) => version.downloadAvailable)?.version ?? "";
    } catch (error) {
      if (generation === this.detailGeneration) {
        this.detailError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (generation === this.detailGeneration) {
        this.detailLoading = false;
      }
    }
  }

  private resetManagementSelection() {
    this.ownerUserId = "";
    this.accessUserId = "";
  }

  private closeDetail() {
    this.detailGeneration += 1;
    this.skillInstall.clear();
    this.detailRef = null;
    this.skillDelete.clear();
    this.skillEdit.clear();
    this.resetManagementSelection();
  }

  private async runManagement(
    operation: () => Promise<unknown>,
    success: string | ((result: unknown) => PlatformClawSkillHubMessage),
  ) {
    if (!this.detailRef || this.managementBusy) {
      return;
    }
    this.managementBusy = true;
    try {
      const result = await operation();
      const ref = this.detailRef;
      await this.openDetail(ref);
      this.message =
        typeof success === "function" ? success(result) : { kind: "success", text: success };
    } catch (error) {
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.managementBusy = false;
    }
  }

  private renderDetail() {
    if (!this.detailRef) {
      return nothing;
    }
    const skill = this.detail?.skill;
    const detailError = this.detailError ?? this.error;
    return html`<openclaw-modal-dialog
      label=${skill?.displayName ?? this.detailRef.slug}
      @modal-cancel=${() => this.closeDetail()}
    >
      <article class="skill-hub-detail">
        <header class="skill-hub-detail__header">
          <div>
            <span class="skill-hub-card__namespace">${this.detailRef.namespace}</span>
            <h2>${skill?.displayName ?? this.detailRef.slug}</h2>
            ${skill?.summary ? html`<p>${skill.summary}</p>` : nothing}
          </div>
          <button class="btn btn--sm" @click=${() => this.closeDetail()}>
            ${t("skillsPage.close")}
          </button>
        </header>
        ${detailError
          ? html`<div class="callout danger" role="alert">${detailError}</div>`
          : nothing}
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
                      ?disabled=${!version.downloadAvailable || this.skillInstall.busy}
                      @change=${() => {
                        this.selectedVersion = version.version;
                        this.skillInstall.cancelConfirmation();
                      }}
                    />
                    <span>
                      <strong>${pageSupport.skillHubVersionLabel(version.version)}</strong>
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
              ${this.skillInstall.render(this.selectedVersion)}
              ${renderSkillHubManagement({
                detail: this.detail,
                selectedOwnerUserId: this.ownerUserId,
                selectedAccessUserId: this.accessUserId,
                forceReason: this.forceReason,
                forceAcknowledged: this.forceAcknowledged,
                busy: this.managementBusy || this.skillDelete.busy || this.skillEdit.busy,
                onEditSkill: () =>
                  this.skillEdit.request(
                    this.detailRef,
                    this.detail,
                    this.config?.namespaces ?? [],
                  ),
                onPublishVersion: () => this.skillUpload.openDialog(this.config, this.detail),
                onSelectOwner: (user) => {
                  this.ownerUserId = user?.id ?? "";
                },
                onTransferOwner: () => {
                  void this.runManagement(
                    () =>
                      transferPlatformClawSkillHubOwner(
                        this.detailRef!.namespace,
                        this.detailRef!.slug,
                        this.ownerUserId,
                        this.detail!.owner!.revision!,
                      ),
                    t("skillHubPage.ownerTransferred"),
                  );
                },
                onSelectAccess: (user) => {
                  this.accessUserId = user?.id ?? "";
                },
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
                    (result) =>
                      (result as { ownershipReviewRequired?: true }).ownershipReviewRequired
                        ? {
                            kind: "warning",
                            text: t("skillHubPage.forcePublishedNeedsOwnershipReview"),
                          }
                        : { kind: "success", text: t("skillHubPage.forcePublished") },
                  );
                },
                onDeleteSkill: () => this.skillDelete.request(this.detailRef, this.detail),
              })}
              ${this.message
                ? html`<div
                    class="callout ${this.message.kind === "error"
                      ? "danger"
                      : this.message.kind === "warning"
                        ? "warning"
                        : "success"}"
                  >
                    ${this.message.text}
                  </div>`
                : nothing}
            `}
      </article>
    </openclaw-modal-dialog>`;
  }

  override render() {
    return renderPluginsHubShell({
      className: "content--skill-hub",
      header: html`<section class="content-header content-header--page plugins-content-header">
        <div>
          <h1 class="page-title">${titleForRoute("skill-hub")}</h1>
          ${this.context?.renderPageHeaderAccessory?.("skill-hub")}
          <div class="page-subtitle">${t("subtitles.skillHub")}</div>
        </div>
        <div class="skill-hub-header-actions">
          ${this.workspacePublish.renderAction(this.config)}
          ${this.config?.admin
            ? html`<button class="btn" @click=${() => this.openAdmin()}>
                ${t("skillHubPage.admin")}
                ${this.config.unassignedOwnerCount
                  ? html`<span class="settings-count">${this.config.unassignedOwnerCount}</span>`
                  : nothing}
              </button>`
            : nothing}
          <button class="btn" @click=${() => this.skillUpload.openDialog(this.config)}>
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
      content: html`<main class="skill-hub-page">
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
                @input=${(event: Event) => (this.query = (event.target as HTMLInputElement).value)}
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
            ? html`<div
                class="callout ${this.message.kind === "error"
                  ? "danger"
                  : this.message.kind === "warning"
                    ? "warning"
                    : "success"}"
              >
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
                    ${this.results.map((item) =>
                      pageSupport.renderSkillHubCard(item, (ref) => void this.openDetail(ref)),
                    )}
                  </div>`
                : html`<div class="skill-hub-state">${t("skillsPage.skillHub.noResults")}</div>`}
          </section>
        </main>
        ${this.renderDetail()} ${this.skillDelete.renderDialog()} ${this.skillEdit.renderDialog()}
        ${renderSkillHubNotifications({
          open: this.notificationsOpen,
          loading: this.notificationsLoading,
          error: this.notificationsError,
          items: this.notifications,
          onClose: () => (this.notificationsOpen = false),
          onMarkAllRead: () => void this.markAllNotificationsRead(),
        })}
        ${this.workspacePublish.renderDialog(this.config)}
        ${this.skillUpload.renderDialog(this.config)}
        ${renderSkillHubAdmin({
          open: this.adminOpen,
          loading: this.adminLoading,
          busy: this.adminBusy,
          error: this.message?.kind === "error" ? this.message.text : this.error,
          message: this.message?.kind === "success" ? this.message.text : null,
          bindings: this.namespaceBindings,
          scopes: this.managedScopes,
          unassigned: this.unassignedSkills,
          draft: this.adminDraft,
          pendingAction: this.pendingAdminAction,
          onClose: () => {
            this.adminOpen = false;
            this.pendingAdminAction = null;
          },
          onDraft: (draft) => (this.adminDraft = draft),
          onSave: () => void this.saveNamespaceBinding(),
          onRequestAction: (action) => (this.pendingAdminAction = action),
          onPendingAction: (action) => (this.pendingAdminAction = action),
          onConfirmAction: () => void this.confirmAdminAction(),
        })}
        ${this.skillInstall.renderConfirmation()}`,
    });
  }
}

customElements.define("openclaw-skill-hub-page", SkillHubPage);
