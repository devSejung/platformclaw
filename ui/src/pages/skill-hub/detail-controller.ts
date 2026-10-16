import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import {
  installPlatformClawHubSkill,
  forcePublishPlatformClawHubSkill,
  grantPlatformClawSkillHubAccess,
  loadPlatformClawSkillHubDetail,
  removePlatformClawSkillHubAccess,
  searchPlatformClawSkillHubManagementUsers,
  transferPlatformClawSkillHubOwner,
  PlatformClawSkillHubRequestError,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubDetail,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubManagementUser,
} from "../../platformclaw/skill-hub.ts";
import { SkillHubAdminController } from "./admin-controller.ts";
import { SkillHubDeleteController } from "./delete-controller.ts";
import {
  skillHubScannerStatusLabel,
  skillHubSkillStatusLabel,
  skillHubVersionStatusLabel,
  skillHubVisibilityLabel,
} from "./labels.ts";
import { renderSkillHubManagement } from "./management.ts";
import * as pageSupport from "./page-support.ts";

export abstract class SkillHubDetailController extends SkillHubAdminController {
  @state() protected config: PlatformClawSkillHubConfig | null = null;
  @state() private detailRef: pageSupport.SkillHubRef | null = null;
  @state() private detail: PlatformClawSkillHubDetail | null = null;
  @state() private detailLoading = false;
  private detailRequest = 0;
  @state() private selectedVersion = "";
  @state() private installation: { target: pageSupport.InstallTarget } | null = null;
  protected get installing(): pageSupport.InstallTarget | null {
    return this.installation?.target ?? null;
  }
  @state() private managementOperation: object | null = null;
  private get managementBusy() {
    return this.managementOperation !== null;
  }
  @state() private ownerUserId = "";
  @state() private accessUserId = "";
  @state() private ownerQuery = "";
  @state() private accessQuery = "";
  @state() private ownerCandidates: PlatformClawSkillHubManagementUser[] = [];
  @state() private accessCandidates: PlatformClawSkillHubManagementUser[] = [];
  @state() private forceReason = "";
  @state() private forceAcknowledged = false;
  @state() protected pendingVersionChange: pageSupport.PendingVersionChange | null = null;
  protected readonly skillDelete = new SkillHubDeleteController(this, {
    refresh: () => this.search(),
    closeDetail: () => this.closeDetail(),
    setMessage: (message) => (this.message = message),
  });

  private get detailBusy() {
    return this.installing !== null || this.managementBusy || this.skillDelete.busy;
  }

  protected abstract search(): Promise<void>;

  override disconnectedCallback() {
    this.closeDetail();
    super.disconnectedCallback();
  }

  private async searchManagementUsers(query: string, purpose: "owner" | "access") {
    if (!this.detailRef || query.trim().length < 2) {
      if (purpose === "owner") {
        this.ownerCandidates = [];
      } else {
        this.accessCandidates = [];
      }
      return;
    }
    const normalized = query.trim();
    const ref = this.detailRef;
    const isCurrent = () =>
      this.detailRef === ref &&
      (purpose === "owner" ? this.ownerQuery : this.accessQuery).trim() === normalized;
    try {
      const result = await searchPlatformClawSkillHubManagementUsers(
        ref.namespace,
        ref.slug,
        normalized,
        purpose,
      );
      if (!isCurrent()) {
        return;
      }
      if (purpose === "owner") {
        this.ownerCandidates = result.items;
      } else {
        this.accessCandidates = result.items;
      }
    } catch (error) {
      if (isCurrent()) {
        this.message = {
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  protected openDetail(ref: pageSupport.SkillHubRef) {
    const selection = { namespace: ref.namespace, slug: ref.slug };
    this.detailRef = selection;
    this.error = null;
    return this.refreshDetail(selection);
  }

  private async refreshDetail(selection: pageSupport.SkillHubRef) {
    const request = ++this.detailRequest;
    const isCurrent = () => this.detailRef === selection && this.detailRequest === request;
    this.resetManagementSelection();
    this.detail = null;
    this.selectedVersion = "";
    this.detailLoading = true;
    this.message = null;
    try {
      const detail = await loadPlatformClawSkillHubDetail(selection.namespace, selection.slug);
      // Refresh request ownership is narrower than the selection that owns actions.
      if (!isCurrent()) {
        return false;
      }
      this.detail = detail;
      this.selectedVersion =
        detail.versions.find((version) => version.downloadAvailable)?.version ?? "";
      return true;
    } catch (error) {
      if (isCurrent()) {
        this.error = error instanceof Error ? error.message : String(error);
      }
      // A refresh failure must not erase the success of the preceding mutation.
      return isCurrent();
    } finally {
      if (isCurrent()) {
        this.detailLoading = false;
      }
    }
  }

  private resetManagementSelection() {
    this.ownerUserId = "";
    this.accessUserId = "";
    this.ownerQuery = "";
    this.accessQuery = "";
    this.ownerCandidates = [];
    this.accessCandidates = [];
    this.forceReason = "";
    this.forceAcknowledged = false;
  }

  private closeDetail() {
    this.detailRef = null;
    this.detail = null;
    this.selectedVersion = "";
    this.pendingVersionChange = null;
    this.installation = null;
    this.managementOperation = null;
    this.skillDelete.clear();
    this.resetManagementSelection();
  }

  protected async install(
    target: pageSupport.InstallTarget,
    versionChange?: pageSupport.PendingVersionChange,
  ) {
    const version = versionChange?.requestedVersion ?? this.selectedVersion;
    if (!this.detailRef || !version || this.detailBusy) {
      return;
    }
    const ref = this.detailRef;
    const installation = { target };
    this.installation = installation;
    this.message = null;
    try {
      const result = await installPlatformClawHubSkill({
        ...ref,
        version,
        destination: target,
        ...(versionChange
          ? {
              acknowledgedReplacement: true as const,
              currentRevision: versionChange.currentRevision,
            }
          : {}),
      });
      if (this.detailRef !== ref) {
        return;
      }
      this.pendingVersionChange = null;
      this.message = {
        kind: "success",
        text: t("skillHubPage.installed", {
          skill: `${result.slug}@${result.version}`,
          target: t(
            target === "assigned_vm" ? "platformClaw.execution.vm" : "platformClaw.execution.basic",
          ),
        }),
      };
    } catch (error) {
      if (this.detailRef !== ref) {
        return;
      }
      if (
        error instanceof PlatformClawSkillHubRequestError &&
        error.details?.code === "existing-skill-replacement-required" &&
        typeof error.details.currentVersion === "string" &&
        typeof error.details.currentRevision === "string" &&
        typeof error.details.requestedVersion === "string" &&
        (error.details.direction === "upgrade" ||
          error.details.direction === "downgrade" ||
          error.details.direction === "reinstall")
      ) {
        this.pendingVersionChange = {
          target,
          currentVersion: error.details.currentVersion,
          currentRevision: error.details.currentRevision,
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
      if (this.installation === installation) {
        this.installation = null;
      }
    }
  }

  private async runManagement(
    operation: () => Promise<unknown>,
    success: string | ((result: unknown) => PlatformClawSkillHubMessage),
  ) {
    if (!this.detailRef || this.detailBusy) {
      return;
    }
    const ref = this.detailRef;
    const operationOwner = {};
    this.managementOperation = operationOwner;
    try {
      const result = await operation();
      if (this.detailRef !== ref || !(await this.refreshDetail(ref))) {
        return;
      }
      this.message =
        typeof success === "function" ? success(result) : { kind: "success", text: success };
    } catch (error) {
      if (this.detailRef === ref) {
        this.message = {
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
        };
      }
    } finally {
      if (this.managementOperation === operationOwner) {
        this.managementOperation = null;
      }
    }
  }

  protected renderDetail() {
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
                      ?disabled=${!version.downloadAvailable || this.detailBusy}
                      @change=${() => (this.selectedVersion = version.version)}
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
              <div class="skill-hub-install-actions">
                <button
                  class="btn primary"
                  ?disabled=${!this.selectedVersion ||
                  this.detailBusy ||
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
                  ?disabled=${!this.selectedVersion || this.detailBusy || vm?.available === false}
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
                ownerQuery: this.ownerQuery,
                accessQuery: this.accessQuery,
                ownerCandidates: this.ownerCandidates,
                accessCandidates: this.accessCandidates,
                selectedOwnerUserId: this.ownerUserId,
                selectedAccessUserId: this.accessUserId,
                forceReason: this.forceReason,
                forceAcknowledged: this.forceAcknowledged,
                busy: this.detailBusy,
                onOwnerQuery: (value) => {
                  this.ownerQuery = value;
                  this.ownerUserId = "";
                  void this.searchManagementUsers(value, "owner");
                },
                onSelectOwner: (user) => {
                  this.ownerUserId = user.id;
                  this.ownerQuery = user.displayName ?? user.accountId;
                  this.ownerCandidates = [];
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
                onAccessQuery: (value) => {
                  this.accessQuery = value;
                  this.accessUserId = "";
                  void this.searchManagementUsers(value, "access");
                },
                onSelectAccess: (user) => {
                  this.accessUserId = user.id;
                  this.accessQuery = user.displayName ?? user.accountId;
                  this.accessCandidates = [];
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
}
