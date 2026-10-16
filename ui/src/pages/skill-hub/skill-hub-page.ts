import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import "../../components/modal-dialog.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { t } from "../../i18n/index.ts";
import {
  loadPlatformClawSkillHubConfig,
  loadPlatformClawSkillHubNotifications,
  markPlatformClawSkillHubNotificationsRead,
  publishPlatformClawSkillArchive,
  searchPlatformClawSkillHub,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubNotification,
  type PlatformClawSkillHubSearchItem,
} from "../../platformclaw/skill-hub.ts";
import "../../styles/plugins.css";
import "../../styles/skill-hub.css";
import { renderPluginsHubShell } from "../plugins/plugins-hub-shell.ts";
import { renderSkillHubAdmin } from "./admin.ts";
import { SkillHubDetailController } from "./detail-controller.ts";
import {
  renderSkillHubNotifications,
  renderSkillHubUpload,
  renderSkillHubVersionChange,
} from "./dialogs.ts";
import * as pageSupport from "./page-support.ts";
import { SkillHubWorkspacePublishController } from "./workspace-publish-controller.ts";

class SkillHubPage extends SkillHubDetailController {
  @state() private query = pageSupport.readSkillHubInitialQuery(window.location.href);
  @state() private results: PlatformClawSkillHubSearchItem[] | null = null;
  @state() private total = 0;
  @state() private loading = true;
  @state() private notificationsOpen = false;
  @state() private notificationsLoading = false;
  @state() private notificationsError: string | null = null;
  @state() private notifications: PlatformClawSkillHubNotification[] = [];
  @state() private uploadOpen = false;
  @state() private uploadFile: File | null = null;
  @state() private uploadSlug = "";
  @state() private uploadNamespace = "";
  @state() private uploadVersion = "1.0.0";
  @state() private uploadVisibility = "NAMESPACE_ONLY";
  @state() private uploading = false;
  private readonly workspacePublish = new SkillHubWorkspacePublishController(this, {
    refresh: () => this.search(),
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
      const publishMessage: PlatformClawSkillHubMessage = {
        kind: result.ownershipReviewRequired ? "warning" : "success",
        text: result.ownershipReviewRequired
          ? t("skillHubPage.publishedNeedsOwnershipReview", {
              skill: `${result.namespace}/${result.slug}@${result.version}`,
            })
          : t("skillHubPage.publishedZip", {
              skill: `${result.namespace}/${result.slug}@${result.version}`,
            }),
      };
      this.uploadOpen = false;
      await this.search();
      this.message = publishMessage;
    } catch (error) {
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.uploading = false;
    }
  }

  protected override async search() {
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
          <button
            class="btn"
            @click=${() => {
              this.message = null;
              this.uploadOpen = true;
            }}
          >
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
        ${this.renderDetail()} ${this.skillDelete.renderDialog()}
        ${renderSkillHubNotifications({
          open: this.notificationsOpen,
          loading: this.notificationsLoading,
          error: this.notificationsError,
          items: this.notifications,
          onClose: () => (this.notificationsOpen = false),
          onMarkAllRead: () => void this.markAllNotificationsRead(),
        })}
        ${this.workspacePublish.renderDialog(this.config)}
        ${renderSkillHubUpload({
          open: this.uploadOpen,
          config: this.config,
          file: this.uploadFile,
          error: this.message?.kind === "error" ? this.message.text : null,
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
    });
  }
}

customElements.define("openclaw-skill-hub-page", SkillHubPage);
