import { consume } from "@lit/context";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { loadPlatformClawLocale } from "../../platformclaw/i18n.ts";
import {
  loadPlatformClawSkillHubConfig,
  cancelPlatformClawSkillHubPublication,
  loadPlatformClawSkillHubDetail,
  loadPlatformClawSkillHubNotifications,
  markPlatformClawSkillHubNotificationsRead,
  platformClawSkillHubDownloadUrl,
  removePlatformClawSkillHubIcon,
  resolvePlatformClawSkillHubLegacyDetail,
  searchPlatformClawSkillHub,
  transferPlatformClawSkillHubOwner,
  uploadPlatformClawSkillHubIcon,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubDetail,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubNotification,
  type PlatformClawSkillHubSearchItem,
} from "../../platformclaw/skill-hub.ts";
import { renderPluginsHubShell } from "../plugins/plugins-hub-shell.ts";
import { SkillHubDeleteController } from "./delete-controller.ts";
import { renderSkillHubNotifications } from "./dialogs.ts";
import { SkillHubEditController } from "./edit-controller.ts";
import { SkillHubInstallController } from "./install-controller.ts";
import {
  skillHubScannerStatusLabel,
  skillHubVisibilityLabel,
  skillHubVersionStatusLabel,
} from "./labels.ts";
import { SkillHubLibraryController } from "./library-controller.ts";
import {
  renderSkillHubManagement,
  renderSkillHubAdminReason,
  validSkillHubAdminReason,
} from "./management.ts";
import {
  readSkillHubInitialQuery,
  refreshSkillHubAfterMutation,
  renderSkillHubCard,
  skillHubVersionLabel,
  type SkillHubRef,
} from "./page-support.ts";
import { SkillHubUploadController } from "./upload-controller.ts";
import { SkillHubWorkspacePublishController } from "./workspace-publish-controller.ts";

export class SkillHubPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @state() private config: PlatformClawSkillHubConfig | null = null;
  @state() private results: PlatformClawSkillHubSearchItem[] | null = null;
  @state() private query = readSkillHubInitialQuery(window.location.href);
  @state() private total = 0;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private message: PlatformClawSkillHubMessage | null = null;
  @state() private detailRef: SkillHubRef | null = null;
  @state() private detail: PlatformClawSkillHubDetail | null = null;
  @state() private detailLoading = false;
  @state() private detailError: string | null = null;
  @state() private selectedVersion = "";
  @state() private ownerUserId = "";
  @state() private managementBusy = false;
  @state() private adminReason = "";
  @state() private publicationReasons: Record<string, string> = {};
  @state() private publicationCancelBusy = false;
  @state() private notificationsOpen = false;
  @state() private notificationsLoading = false;
  @state() private notificationsError: string | null = null;
  @state() private notifications: PlatformClawSkillHubNotification[] = [];
  private detailGeneration = 0;
  private searchGeneration = 0;
  private refreshGeneration = 0;

  private readonly skillInstall = new SkillHubInstallController(
    this,
    (message) => (this.message = message),
  );
  private readonly workspacePublish = new SkillHubWorkspacePublishController(this, {
    refresh: (ref) => this.refreshAfterMutation(ref),
    setMessage: (message) => (this.message = message),
  });
  private readonly skillUpload = new SkillHubUploadController(this, {
    refresh: (ref) => this.refreshAfterMutation(ref),
    setMessage: (message) => (this.message = message),
  });
  private readonly skillDelete = new SkillHubDeleteController(this, {
    refresh: () => this.refresh(),
    closeDetail: () => this.closeDetail(),
    setMessage: (message) => (this.message = message),
  });
  private readonly skillEdit = new SkillHubEditController(this, {
    refresh: (ref) => this.refreshAfterMutation(ref),
    setMessage: (message) => (this.message = message),
  });
  private readonly library = new SkillHubLibraryController(this, () => this.refresh());

  override connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    try {
      await loadPlatformClawLocale();
      await this.refresh();
      const params = new URL(window.location.href).searchParams;
      const id = params.get("skill");
      if (id) {
        await this.openDetail({ id, slug: "" });
      } else if (params.get("namespace") && params.get("slug")) {
        const resolved = await resolvePlatformClawSkillHubLegacyDetail(
          params.get("namespace")!,
          params.get("slug")!,
        );
        await this.openDetail({ id: resolved.skill.id, slug: resolved.skill.slug });
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.loading = false;
    }
  }

  private async refresh() {
    const generation = ++this.refreshGeneration;
    try {
      const config = await loadPlatformClawSkillHubConfig();
      if (generation !== this.refreshGeneration) {
        return;
      }
      this.config = config;
      const result = await this.search();
      if (!result.ok) {
        throw new Error(result.error);
      }
    } catch (error) {
      if (generation === this.refreshGeneration) {
        throw error;
      }
    }
  }

  private async refreshAfterMutation(ref: SkillHubRef | null) {
    const generation = this.detailGeneration;
    await this.refresh();
    // A completed change refreshes only its still-open detail, never a dismissed or newer view.
    if (!ref || this.detailRef?.id !== ref.id || generation !== this.detailGeneration) {
      return;
    }
    const result = await this.openDetail(ref);
    if (!result.ok) {
      throw new Error(result.error);
    }
  }

  private async search(): Promise<Result<undefined, string>> {
    const generation = ++this.searchGeneration;
    this.loading = true;
    this.error = null;
    try {
      const result = await searchPlatformClawSkillHub(this.query.trim());
      if (generation !== this.searchGeneration) {
        return ok(undefined);
      }
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
      if (generation === this.searchGeneration) {
        this.error = error instanceof Error ? error.message : String(error);
        return err(this.error);
      }
    } finally {
      if (generation === this.searchGeneration) {
        this.loading = false;
      }
    }
    return ok(undefined);
  }

  private async openDetail(ref: SkillHubRef): Promise<Result<undefined, string>> {
    if (this.managementBusy) {
      return ok(undefined);
    }
    const generation = ++this.detailGeneration;
    this.skillInstall.clear();
    this.ownerUserId = "";
    this.adminReason = "";
    this.detailRef = { ...ref };
    this.detail = null;
    this.selectedVersion = "";
    this.detailError = null;
    this.detailLoading = true;
    try {
      const detail = await loadPlatformClawSkillHubDetail(ref.id);
      if (generation !== this.detailGeneration) {
        return ok(undefined);
      }
      this.detail = detail;
      this.detailRef = { id: detail.skill.id, slug: detail.skill.slug };
      this.selectedVersion =
        detail.versions.find((version) => version.downloadAvailable)?.version ?? "";
      this.skillInstall.open(this.detailRef, this.config);
      const url = new URL(window.location.href);
      url.searchParams.set("skill", detail.skill.id);
      url.searchParams.delete("namespace");
      url.searchParams.delete("slug");
      window.history.replaceState(window.history.state, "", url);
    } catch (error) {
      if (generation === this.detailGeneration) {
        this.detailError = error instanceof Error ? error.message : String(error);
        return err(this.detailError);
      }
    } finally {
      if (generation === this.detailGeneration) {
        this.detailLoading = false;
      }
    }
    return ok(undefined);
  }

  private closeDetail() {
    if (this.managementBusy) {
      return;
    }
    this.detailGeneration++;
    this.detailRef = null;
    this.detail = null;
    this.skillInstall.clear();
    this.skillEdit.clear();
    const url = new URL(window.location.href);
    url.searchParams.delete("skill");
    window.history.replaceState(window.history.state, "", url);
  }

  private async runManagement(operation: () => Promise<unknown>, text: string) {
    if (!this.detailRef || this.managementBusy) {
      return;
    }
    const ref = this.detailRef;
    this.managementBusy = true;
    this.message = null;
    try {
      await operation();
      this.managementBusy = false;
      await refreshSkillHubAfterMutation(
        text,
        () => this.refreshAfterMutation(ref),
        (message) => (this.message = message),
      );
    } catch (error) {
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.managementBusy = false;
    }
  }

  private uploadIcon(file: File) {
    if (!this.detail || !this.config) {
      return;
    }
    if (
      file.size > this.config.limits.iconBytes ||
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ) {
      this.message = { kind: "error", text: t("skillHubPage.iconHelp") };
      return;
    }
    const skill = this.detail.skill;
    void this.runManagement(
      () =>
        uploadPlatformClawSkillHubIcon(
          skill.id,
          skill.revision,
          file,
          !this.detail?.owner.isMine ? this.adminReason.trim() : undefined,
        ),
      t("skillHubPage.iconSaved"),
    );
  }

  private async cancelPublication(operationId: string, reason?: string) {
    if (this.publicationCancelBusy) {
      return;
    }
    this.publicationCancelBusy = true;
    try {
      await cancelPlatformClawSkillHubPublication(operationId, reason);
      this.workspacePublish.forgetPublication(operationId);
      this.skillUpload.forgetPublication(operationId);
      await refreshSkillHubAfterMutation(
        t("skillHubPage.publicationCancelled"),
        () => this.refresh(),
        (message) => (this.message = message),
      );
    } catch (error) {
      this.message = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.publicationCancelBusy = false;
    }
  }

  private async openNotifications() {
    this.notificationsOpen = true;
    this.notificationsLoading = true;
    this.notificationsError = null;
    try {
      const result = await loadPlatformClawSkillHubNotifications();
      this.notifications = result.items;
      if (this.config) {
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
      if (this.config) {
        this.config = { ...this.config, notifications: { unreadCount: 0 } };
      }
    } catch (error) {
      this.notificationsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.notificationsLoading = false;
    }
  }

  private renderDetail() {
    if (!this.detailRef) {
      return nothing;
    }
    const detail = this.detail;
    const skill = detail?.skill;
    const busy = this.managementBusy || this.skillDelete.busy || this.skillEdit.busy;
    return html`<openclaw-modal-dialog
      label=${skill?.displayName ?? this.detailRef.slug}
      @modal-cancel=${(event: Event) => (busy ? event.preventDefault() : this.closeDetail())}
    >
      <article class="skill-hub-detail">
        <header class="skill-hub-detail__header">
          <div class="skill-hub-identity">
            ${skill?.iconUrl
              ? html`<img class="skill-hub-icon" src=${skill.iconUrl} alt="" />`
              : html`<span class="skill-hub-icon skill-hub-icon--default" aria-hidden="true"
                  >◇</span
                >`}
            <div>
              <h2>${skill?.displayName ?? this.detailRef.slug}</h2>
              <p>${skill?.summary}</p>
              ${detail
                ? html`<small
                    >${t("skillHubPage.owner")}:
                    ${detail.owner.user?.displayName ??
                    detail.owner.user?.accountId ??
                    t("skillHubPage.ownerUnassigned")}</small
                  >`
                : nothing}
            </div>
          </div>
          <button class="btn btn--sm" ?disabled=${busy} @click=${() => this.closeDetail()}>
            ${t("skillsPage.close")}
          </button>
        </header>
        ${this.detailError
          ? html`<div class="callout danger" role="alert">${this.detailError}</div>`
          : nothing}
        ${this.detailLoading
          ? html`<p role="status">${t("common.loading")}</p>`
          : detail && skill
            ? html`
                <div class="skill-hub-badges">
                  <span class="skill-hub-badge"
                    >${skillHubVisibilityLabel(skill.sharing.mode)}</span
                  >
                  ${detail.scanner
                    ? html`<span class="skill-hub-badge is-${detail.scanner.status}"
                        >${skillHubScannerStatusLabel(detail.scanner.status)}</span
                      >`
                    : nothing}
                  ${skill.tags.map((tag) => html`<span class="skill-hub-tag">${tag}</span>`)}
                </div>
                <section class="skill-hub-versions">
                  <h3>${t("skillHubPage.versions")}</h3>
                  ${detail.versions.map(
                    (version) => html`<label class="skill-hub-version"
                      ><input
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
                      <span
                        ><strong>${skillHubVersionLabel(version.version)}</strong
                        ><small>${skillHubVersionStatusLabel(version.status)}</small>
                        ${version.scanner
                          ? html`<small class="skill-hub-badge is-${version.scanner.status}"
                              >${skillHubScannerStatusLabel(version.scanner.status)}</small
                            >`
                          : nothing}</span
                      >
                      <span class="skill-hub-version__size"
                        >${version.totalSize
                          ? `${Math.ceil(version.totalSize / 1024)} KB`
                          : ""}</span
                      ></label
                    >`,
                  )}
                </section>
                ${this.skillInstall.render(this.selectedVersion)}
                <div class="skill-hub-install-actions">
                  ${this.selectedVersion
                    ? html`<a
                        class="btn"
                        href=${platformClawSkillHubDownloadUrl(skill.id, this.selectedVersion)}
                        download
                        >${t("skillHubPage.downloadZip")}</a
                      >`
                    : nothing}
                  <button
                    class="btn"
                    @click=${() => void this.library.open({ kind: "history", id: skill.id })}
                  >
                    ${t("skillHubPage.history")}
                  </button>
                </div>
                ${renderSkillHubManagement({
                  detail,
                  adminReason: this.adminReason,
                  onAdminReason: (reason) => {
                    this.adminReason = reason;
                  },
                  selectedOwnerUserId: this.ownerUserId,
                  busy,
                  onEditSkill: () =>
                    this.skillEdit.request(
                      this.detailRef,
                      detail,
                      this.config,
                      !detail.owner.isMine ? this.adminReason.trim() : undefined,
                    ),
                  onWorkspaceVersion: () =>
                    this.config &&
                    void this.workspacePublish.openDialog(
                      this.config,
                      detail,
                      undefined,
                      !detail.owner.isMine ? this.adminReason.trim() : undefined,
                    ),
                  onZipVersion: () =>
                    this.skillUpload.openDialog(
                      this.config,
                      detail,
                      !detail.owner.isMine ? this.adminReason.trim() : undefined,
                    ),
                  onSelectOwner: (user) => (this.ownerUserId = user?.id ?? ""),
                  onTransferOwner: () =>
                    void this.runManagement(
                      () =>
                        transferPlatformClawSkillHubOwner(
                          skill.id,
                          this.ownerUserId,
                          skill.revision,
                          !detail.owner.isMine ? this.adminReason.trim() : undefined,
                        ),
                      t("skillHubPage.transferRequested"),
                    ),
                  onDeleteSkill: () =>
                    this.skillDelete.request(
                      this.detailRef,
                      detail,
                      !detail.owner.isMine ? this.adminReason.trim() : undefined,
                    ),
                  onIcon: (file) => this.uploadIcon(file),
                  onRemoveIcon: () =>
                    void this.runManagement(
                      () =>
                        removePlatformClawSkillHubIcon(
                          skill.id,
                          skill.revision,
                          !detail.owner.isMine ? this.adminReason.trim() : undefined,
                        ),
                      t("skillHubPage.iconSaved"),
                    ),
                })}
                ${this.message
                  ? html`<div
                      class="callout ${this.message.kind === "error"
                        ? "danger"
                        : this.message.kind}"
                      role="status"
                    >
                      ${this.message.text}
                    </div>`
                  : nothing}
              `
            : nothing}
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
          <button
            class="btn"
            ?disabled=${!this.config}
            @click=${() => this.skillUpload.openDialog(this.config)}
          >
            ${t("skillHubPage.uploadZip")}
          </button>
          <button class="btn" @click=${() => void this.library.open({ kind: "trash" })}>
            ${t("skillHubPage.trash")}
          </button>
          <button class="btn" @click=${() => void this.library.open({ kind: "transfers" })}>
            ${t("skillHubPage.transfers")}
          </button>
          <button class="btn" @click=${() => void this.openNotifications()}>
            ${t("skillHubPage.notifications")}${this.config?.notifications?.unreadCount
              ? html`<span class="settings-count">${this.config.notifications.unreadCount}</span>`
              : nothing}
          </button>
        </div>
      </section>`,
      content: html`<main class="skill-hub-page">
          <section class="skill-hub-toolbar">
            <form
              class="skill-hub-search"
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                void this.search();
              }}
            >
              <input
                class="settings-input"
                type="search"
                aria-label=${t("skillsPage.skillHub.searchPlaceholder")}
                .value=${this.query}
                placeholder=${t("skillsPage.skillHub.searchPlaceholder")}
                @input=${(event: Event) => (this.query = (event.target as HTMLInputElement).value)}
              /><button type="submit" class="btn primary" ?disabled=${this.loading}>
                ${t(this.loading ? "skillsPage.skillHub.searching" : "skillsPage.skillHub.search")}
              </button>
            </form>
          </section>
          ${this.error
            ? html`<div class="callout danger" role="alert">${this.error}</div>
                <button class="btn" @click=${() => void this.load()}>${t("common.reload")}</button>`
            : nothing}
          ${this.config?.maintenanceError
            ? html`<div class="callout warning" role="alert">${this.config.maintenanceError}</div>`
            : nothing}
          ${this.config?.pendingPublications?.map(
            (publication) => html`<div class="callout warning skill-hub-pending-publication">
              <strong>${publication.displayName ?? publication.slug ?? publication.skillId}</strong>
              <p>${t("skillHubPage.publicationPending", { version: publication.version })}</p>
              ${!publication.isMine
                ? renderSkillHubAdminReason(
                    this.publicationReasons[publication.operationId] ?? "",
                    (reason) => {
                      this.publicationReasons = {
                        ...this.publicationReasons,
                        [publication.operationId]: reason,
                      };
                    },
                    this.publicationCancelBusy,
                  )
                : nothing}
              <button
                class="btn btn--sm"
                ?disabled=${this.publicationCancelBusy ||
                (!publication.isMine &&
                  !validSkillHubAdminReason(
                    this.publicationReasons[publication.operationId] ?? "",
                  ))}
                @click=${() =>
                  void this.cancelPublication(
                    publication.operationId,
                    !publication.isMine
                      ? this.publicationReasons[publication.operationId]?.trim()
                      : undefined,
                  )}
              >
                ${t("skillHubPage.cancelPublication")}
              </button>
            </div>`,
          )}
          ${this.message
            ? html`<div
                class="callout ${this.message.kind === "error" ? "danger" : this.message.kind}"
                role="status"
              >
                ${this.message.text}
              </div>`
            : nothing}
          <section class="skill-hub-results" aria-busy=${this.loading}>
            <header>
              <h2>${t("skillHubPage.catalog")}</h2>
              <span>${t("skillHubPage.resultCount", { count: String(this.total) })}</span>
            </header>
            ${this.loading && !this.results
              ? html`<p role="status">${t("common.loading")}</p>`
              : this.results?.length
                ? html`<div class="skill-hub-grid">
                    ${this.results.map((item) =>
                      renderSkillHubCard(item, (ref) => void this.openDetail(ref)),
                    )}
                  </div>`
                : html`<div class="skill-hub-state">${t("skillsPage.skillHub.noResults")}</div>`}
          </section>
        </main>
        ${this.renderDetail()}${this.skillDelete.renderDialog()}${this.skillEdit.renderDialog()}${this.workspacePublish.renderDialog(
          this.config,
        )}${this.skillUpload.renderDialog(
          this.config,
        )}${this.library.render()}${this.skillInstall.renderConfirmation()}
        ${renderSkillHubNotifications({
          open: this.notificationsOpen,
          loading: this.notificationsLoading,
          error: this.notificationsError,
          items: this.notifications,
          onClose: () => (this.notificationsOpen = false),
          onMarkAllRead: () => void this.markAllNotificationsRead(),
        })}`,
    });
  }
}

customElements.define("openclaw-skill-hub-page", SkillHubPage);
