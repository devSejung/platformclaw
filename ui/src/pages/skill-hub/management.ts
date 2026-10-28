import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import "./user-picker.ts";
import type {
  PlatformClawSkillHubDetail,
  PlatformClawSkillHubUser,
} from "../../platformclaw/skill-hub.ts";

export function validSkillHubAdminReason(reason: string) {
  const length = Array.from(reason.trim()).length;
  return length > 0 && length <= 500;
}

export function renderSkillHubAdminReason(
  reason: string,
  onChange: (value: string) => void,
  disabled = false,
) {
  return html`<label class="field"
    ><span>${t("skillHubPage.adminReason")}</span
    ><textarea
      name="adminReason"
      required
      maxlength="500"
      .value=${reason}
      ?disabled=${disabled}
      @input=${(event: Event) => onChange((event.target as HTMLTextAreaElement).value)}
    ></textarea
    ><small>${t("skillHubPage.adminReasonHelp")}</small></label
  >`;
}

export function renderSkillHubManagement(props: {
  detail: PlatformClawSkillHubDetail;
  selectedOwnerUserId: string;
  busy: boolean;
  adminReason: string;
  onAdminReason: (reason: string) => void;
  onSelectOwner: (user: PlatformClawSkillHubUser | null) => void;
  onTransferOwner: () => void;
  onDeleteSkill: () => void;
  onEditSkill: () => void;
  onWorkspaceVersion: () => void;
  onZipVersion: () => void;
  onIcon: (file: File) => void;
  onRemoveIcon: () => void;
}) {
  if (!props.detail.canManage) {
    return nothing;
  }
  const mutationDisabled =
    props.busy || (!props.detail.owner.isMine && !validSkillHubAdminReason(props.adminReason));
  return html`<section class="skill-hub-management">
    <h3>${t("skillHubPage.management")}</h3>
    ${!props.detail.owner.isMine
      ? renderSkillHubAdminReason(props.adminReason, props.onAdminReason, props.busy)
      : nothing}
    <div class="skill-hub-management__group">
      <div>
        <strong>${t("skillHubPage.publishedDetails")}</strong>
        <p>${t("skillHubPage.metadataHelp")}</p>
      </div>
      <div class="skill-hub-install-actions">
        <button class="btn" ?disabled=${mutationDisabled} @click=${props.onEditSkill}>
          ${t("skillHubPage.editSkill")}
        </button>
      </div>
      <label class="field"
        ><span>${t("skillHubPage.icon")}</span
        ><input
          type="file"
          name="icon"
          accept="image/png,image/jpeg,image/webp"
          ?disabled=${mutationDisabled}
          @change=${(event: Event) => {
            const input = event.target as HTMLInputElement;
            const file = input.files?.[0];
            if (file) {
              props.onIcon(file);
            }
            input.value = "";
          }}
        /><small>${t("skillHubPage.iconHelp")}</small></label
      >
      ${props.detail.skill.iconUrl
        ? html`<button
            class="btn btn--sm"
            ?disabled=${mutationDisabled}
            @click=${props.onRemoveIcon}
          >
            ${t("skillHubPage.removeIcon")}
          </button>`
        : nothing}
    </div>
    <div class="skill-hub-management__group">
      <strong>${t("skillHubPage.publishVersion")}</strong>
      <p>${t("skillHubPage.publishVersionHelp")}</p>
      <div class="skill-hub-install-actions">
        <button class="btn" ?disabled=${mutationDisabled} @click=${props.onWorkspaceVersion}>
          ${t("skillHubPage.versionFromWorkspace")}</button
        ><button class="btn" ?disabled=${mutationDisabled} @click=${props.onZipVersion}>
          ${t("skillHubPage.versionFromZip")}
        </button>
      </div>
    </div>
    <div class="skill-hub-management__group">
      <div>
        <strong>${t("skillHubPage.owner")}</strong>
        <p>
          ${props.detail.owner.user?.displayName ??
          props.detail.owner.user?.accountId ??
          t("skillHubPage.ownerUnassigned")}
        </p>
        <small>${t("skillHubPage.transferHelp")}</small>
      </div>
      <div class="skill-hub-management__action">
        <openclaw-skill-hub-user-picker
          purpose="owner"
          .disabled=${props.busy}
          .onSelect=${props.onSelectOwner}
        ></openclaw-skill-hub-user-picker>
        <button
          class="btn"
          ?disabled=${mutationDisabled || !props.selectedOwnerUserId}
          @click=${props.onTransferOwner}
        >
          ${t("skillHubPage.transferOwner")}
        </button>
      </div>
    </div>
    <div class="skill-hub-management__group">
      <p>${t("skillHubPage.trashHelp")}</p>
      <button class="btn danger" ?disabled=${mutationDisabled} @click=${props.onDeleteSkill}>
        ${t("skillHubPage.moveToTrash")}
      </button>
    </div>
  </section>`;
}
