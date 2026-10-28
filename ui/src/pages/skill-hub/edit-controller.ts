import { html, nothing, type ReactiveControllerHost } from "lit";
import { t } from "../../i18n/index.ts";
import {
  editPlatformClawSkillHubSkill,
  loadPlatformClawSkillHubConfig,
  loadPlatformClawSkillHubDetail,
  PlatformClawSkillHubRequestError,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubDetail,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubSharingDetail,
} from "../../platformclaw/skill-hub.ts";
import { skillHubVisibilityLabel } from "./labels.ts";
import { renderSkillHubAdminReason, validSkillHubAdminReason } from "./management.ts";
import { refreshSkillHubAfterMutation, type SkillHubRef } from "./page-support.ts";
import {
  renderSkillHubSharing,
  skillHubSharingInvalid,
  skillHubSharingRequest,
} from "./sharing.ts";

export class SkillHubEditController {
  private pending: {
    ref: SkillHubRef;
    revision: number;
    reason?: string;
    requiresReason: boolean;
    displayName: string;
    summary: string;
    tags: string;
    sharing: PlatformClawSkillHubSharingDetail;
    sharingChanged: boolean;
    config: PlatformClawSkillHubConfig;
  } | null = null;
  private saving = false;
  private reloading = false;
  private reloadRequired = false;
  private latest: PlatformClawSkillHubDetail | null = null;
  private canManage = true;
  private error: string | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: {
      refresh: (ref: SkillHubRef) => Promise<void>;
      setMessage: (message: PlatformClawSkillHubMessage | null) => void;
    },
  ) {}

  get busy(): boolean {
    return this.saving;
  }

  request(
    ref: SkillHubRef | null,
    detail: PlatformClawSkillHubDetail | null,
    config: PlatformClawSkillHubConfig | null,
    reason?: string,
  ) {
    if (!ref || !detail?.canManage || !detail.sharing || !config || this.saving) {
      return;
    }
    this.pending = {
      ref: { ...ref },
      ...(reason ? { reason } : {}),
      requiresReason: !detail.owner.isMine,
      revision: detail.skill.revision,
      displayName: detail.skill.displayName,
      summary: detail.skill.summary,
      tags: detail.skill.tags.join(", "),
      sharing: {
        ...detail.sharing,
        userIds: [...detail.sharing.userIds],
        scopeIds: [...detail.sharing.scopeIds],
        users: [...detail.sharing.users],
        scopes: [...detail.sharing.scopes],
      },
      sharingChanged: false,
      config,
    };
    this.error = null;
    this.reloading = false;
    this.reloadRequired = false;
    this.latest = null;
    this.canManage = true;
    this.options.setMessage(null);
    this.host.requestUpdate();
  }

  clear() {
    if (this.saving) {
      return;
    }
    this.pending = null;
    this.error = null;
    this.reloading = false;
    this.reloadRequired = false;
    this.latest = null;
    this.host.requestUpdate();
  }

  renderDialog() {
    const draft = this.pending;
    if (!draft) {
      return nothing;
    }
    const tags = draft.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const invalid =
      this.reloadRequired ||
      !this.canManage ||
      (draft.requiresReason && !validSkillHubAdminReason(draft.reason ?? "")) ||
      !draft.displayName.trim() ||
      tags.length > draft.config.limits.tags ||
      tags.some((tag) => Array.from(tag).length > draft.config.limits.tagChars) ||
      (draft.sharingChanged && skillHubSharingInvalid(draft.sharing));
    const controlsBusy = this.saving || this.reloading;
    return html`<openclaw-modal-dialog
      label=${t("skillHubPage.editSkill")}
      @modal-cancel=${(event: Event) => (this.saving ? event.preventDefault() : this.clear())}
    >
      <form
        class="skill-hub-dialog skill-hub-edit"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          if (!invalid) {
            void this.save();
          }
        }}
      >
        <header class="skill-hub-dialog__header">
          <div>
            <h2>${t("skillHubPage.editSkill")}</h2>
            <p>${t("skillHubPage.metadataHelp")}</p>
          </div>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${this.saving}
            @click=${() => this.clear()}
          >
            ${t("skillsPage.close")}
          </button>
        </header>
        <label class="field"
          ><span>${t("skillHubPage.displayName")}</span>
          <input
            name="displayName"
            required
            maxlength="200"
            .value=${draft.displayName}
            ?disabled=${controlsBusy}
            ?readonly=${!this.canManage}
            @input=${(event: Event) => {
              draft.displayName = (event.target as HTMLInputElement).value;
              this.host.requestUpdate();
            }}
        /></label>
        <label class="field"
          ><span>${t("skillHubPage.summary")}</span>
          <textarea
            name="summary"
            maxlength="4000"
            .value=${draft.summary}
            ?disabled=${controlsBusy}
            ?readonly=${!this.canManage}
            @input=${(event: Event) => {
              draft.summary = (event.target as HTMLTextAreaElement).value;
            }}
          ></textarea>
        </label>
        <label class="field"
          ><span>${t("skillHubPage.tags")}</span>
          <input
            name="tags"
            .value=${draft.tags}
            ?disabled=${controlsBusy}
            ?readonly=${!this.canManage}
            @input=${(event: Event) => {
              draft.tags = (event.target as HTMLInputElement).value;
              this.host.requestUpdate();
            }}
          />
          <small>${t("skillHubPage.tagsHelp")}</small></label
        >
        ${renderSkillHubSharing({
          draft: draft.sharing,
          config: draft.config,
          disabled: controlsBusy || !this.canManage,
          onChange: (sharing) => {
            draft.sharing = sharing;
            draft.sharingChanged = true;
            this.host.requestUpdate();
          },
        })}
        ${draft.requiresReason
          ? renderSkillHubAdminReason(
              draft.reason ?? "",
              (reason) => {
                draft.reason = reason;
                this.host.requestUpdate();
              },
              controlsBusy || !this.canManage,
            )
          : nothing}
        ${this.latest
          ? html`<details class="callout skill-hub-edit-latest" open>
              <summary>${t("skillHubPage.latestSavedValues")}</summary>
              <p role="status">${t("skillHubPage.reviewLatestWithDraft")}</p>
              <dl>
                <dt>${t("skillHubPage.displayName")}</dt>
                <dd>${this.latest.skill.displayName}</dd>
                <dt>${t("skillHubPage.summary")}</dt>
                <dd>${this.latest.skill.summary}</dd>
                <dt>${t("skillHubPage.tags")}</dt>
                <dd>${this.latest.skill.tags.join(", ")}</dd>
                <dt>${t("skillHubPage.sharing")}</dt>
                <dd>
                  ${skillHubVisibilityLabel(this.latest.skill.sharing.mode)}
                  ${this.latest.sharing?.users
                    .map((user) => user.displayName ?? user.accountId)
                    .join(", ")}
                  ${this.latest.sharing?.scopes.map((scope) => scope.name).join(", ")}
                </dd>
              </dl>
            </details>`
          : nothing}
        ${this.error ? html`<div class="callout danger" role="alert">${this.error}</div>` : nothing}
        ${this.error
          ? html`<button
              type="button"
              class="btn"
              ?disabled=${controlsBusy}
              @click=${() => void this.reloadLatest()}
            >
              ${t(this.reloading ? "skillHubPage.reloadingSkill" : "skillHubPage.reloadLatest")}
            </button>`
          : nothing}
        <div class="skill-hub-install-actions">
          <button type="button" class="btn" ?disabled=${this.saving} @click=${() => this.clear()}>
            ${t("common.cancel")}
          </button>
          <button type="submit" class="btn primary" ?disabled=${controlsBusy || invalid}>
            ${t(this.saving ? "skillHubPage.savingSkill" : "skillHubPage.saveSkill")}
          </button>
        </div>
      </form>
    </openclaw-modal-dialog>`;
  }

  private async reloadLatest() {
    const draft = this.pending;
    if (!draft || this.saving || this.reloading) {
      return;
    }
    this.reloading = true;
    this.host.requestUpdate();
    try {
      const [detail, config] = await Promise.all([
        loadPlatformClawSkillHubDetail(draft.ref.id),
        loadPlatformClawSkillHubConfig(),
      ]);
      if (this.pending !== draft) {
        return;
      }
      if (detail.skill.id !== draft.ref.id) {
        throw new Error(t("skillHubPage.editIdentityChanged"));
      }
      this.latest = detail;
      draft.revision = detail.skill.revision;
      draft.config = config;
      draft.requiresReason = !detail.owner.isMine;
      this.canManage = detail.canManage && Boolean(detail.sharing);
      // No metadata merge: show current values alongside the retained draft.
      // Untouched sharing always follows the server; reloading must not reopen a
      // newly Private skill just because this editor originally showed Public.
      if (!draft.sharingChanged && detail.sharing) {
        draft.sharing = {
          ...detail.sharing,
          userIds: [...detail.sharing.userIds],
          scopeIds: [...detail.sharing.scopeIds],
          users: [...detail.sharing.users],
          scopes: [...detail.sharing.scopes],
        };
      }
      this.reloadRequired = false;
      this.error = this.canManage ? null : t("skillHubPage.editAccessLost");
    } catch (error) {
      if (this.pending === draft) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (this.pending === draft) {
        this.reloading = false;
        this.host.requestUpdate();
      }
    }
  }

  private async save() {
    const draft = this.pending;
    if (!draft || this.saving || this.reloading || this.reloadRequired || !this.canManage) {
      return;
    }
    this.saving = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      await editPlatformClawSkillHubSkill(draft.ref.id, {
        expectedRevision: draft.revision,
        ...(draft.reason ? { reason: draft.reason } : {}),
        displayName: draft.displayName,
        summary: draft.summary,
        tags: draft.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        ...(draft.sharingChanged ? { sharing: skillHubSharingRequest(draft.sharing) } : {}),
      });
      this.pending = null;
      this.host.requestUpdate();
      await refreshSkillHubAfterMutation(
        t("skillHubPage.editedSkill", { skill: draft.displayName }),
        () => this.options.refresh(draft.ref),
        this.options.setMessage,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.pending) {
        this.error = message;
        this.reloadRequired =
          error instanceof PlatformClawSkillHubRequestError && error.status === 409;
      } else {
        this.options.setMessage({ kind: "error", text: message });
      }
    } finally {
      this.saving = false;
      this.host.requestUpdate();
    }
  }
}
