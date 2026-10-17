import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import "./user-picker.ts";
import type {
  PlatformClawSkillHubDetail,
  PlatformClawSkillHubManagementUser,
} from "../../platformclaw/skill-hub.ts";

export function renderSkillHubManagement(props: {
  detail: PlatformClawSkillHubDetail | null;
  selectedOwnerUserId: string;
  selectedAccessUserId: string;
  forceReason: string;
  forceAcknowledged: boolean;
  busy: boolean;
  onSelectOwner: (user: PlatformClawSkillHubManagementUser | null) => void;
  onTransferOwner: () => void;
  onSelectAccess: (user: PlatformClawSkillHubManagementUser | null) => void;
  onGrantAccess: () => void;
  onRemoveAccess: (userId: string) => void;
  onForceReason: (value: string) => void;
  onForceAcknowledged: (value: boolean) => void;
  onForcePublish: () => void;
  onDeleteSkill: () => void;
  onEditSkill: () => void;
  onPublishVersion: () => void;
}) {
  if (!props.detail?.canManage) {
    return nothing;
  }
  return html`<section class="skill-hub-management">
    <h3>${t("skillHubPage.management")}</h3>
    <div class="skill-hub-management__group">
      <div>
        <strong>${t("skillHubPage.publishedDetails")}</strong>
        <p>${t("skillHubPage.publishVersionHelp")}</p>
      </div>
      <div class="skill-hub-install-actions">
        ${props.detail.skill.revision && typeof props.detail.owner?.revision === "number"
          ? html`<button class="btn btn--sm" ?disabled=${props.busy} @click=${props.onEditSkill}>
              ${t("skillHubPage.editSkill")}
            </button>`
          : nothing}
        <button class="btn btn--sm" ?disabled=${props.busy} @click=${props.onPublishVersion}>
          ${t("skillHubPage.publishVersion")}
        </button>
      </div>
    </div>
    <div class="skill-hub-management__group">
      <div>
        <strong>${t("skillHubPage.owner")}</strong>
        <p>
          ${props.detail.owner?.user?.displayName ??
          props.detail.owner?.user?.accountId ??
          (props.detail.owner?.isMine
            ? t("skillHubPage.ownerYou")
            : props.detail.owner?.assigned
              ? t("skillHubPage.ownerAssigned")
              : t("skillHubPage.ownerUnassigned"))}
        </p>
      </div>
      <div class="skill-hub-management__action">
        <openclaw-skill-hub-user-picker
          namespace=${props.detail.skill.namespace}
          slug=${props.detail.skill.slug}
          purpose="owner"
          .disabled=${props.busy}
          .onSelect=${props.onSelectOwner}
        ></openclaw-skill-hub-user-picker>
        <button
          class="btn btn--sm"
          ?disabled=${props.busy || !props.selectedOwnerUserId}
          @click=${props.onTransferOwner}
        >
          ${t("skillHubPage.transferOwner")}
        </button>
      </div>
    </div>
    <div class="skill-hub-management__group">
      <div>
        <strong>${t("skillHubPage.individualAccess")}</strong>
        <p>${t("skillHubPage.individualAccessHelp")}</p>
      </div>
      <div class="skill-hub-management__action">
        <openclaw-skill-hub-user-picker
          namespace=${props.detail.skill.namespace}
          slug=${props.detail.skill.slug}
          purpose="access"
          .disabled=${props.busy}
          .onSelect=${props.onSelectAccess}
        ></openclaw-skill-hub-user-picker>
        <button
          class="btn btn--sm"
          ?disabled=${props.busy || !props.selectedAccessUserId}
          @click=${props.onGrantAccess}
        >
          ${t("skillHubPage.grantAccess")}
        </button>
      </div>
      ${props.detail.access?.length
        ? html`<div class="skill-hub-access-list">
            ${props.detail.access.map(
              (grant) => html`<span>
                ${grant.userId}
                <button
                  class="btn btn--sm"
                  ?disabled=${props.busy}
                  @click=${() => props.onRemoveAccess(grant.userId)}
                >
                  ${t("skillHubPage.revoke")}
                </button>
              </span>`,
            )}
          </div>`
        : nothing}
    </div>
    ${props.detail.scanner?.status === "failed"
      ? html`<div class="skill-hub-management__group skill-hub-force">
          <div>
            <strong>${t("skillHubPage.forcePublish")}</strong>
            <p>${t("skillHubPage.forcePublishHelp")}</p>
          </div>
          <textarea
            .value=${props.forceReason}
            placeholder=${t("skillHubPage.forceReason")}
            @input=${(event: Event) =>
              props.onForceReason((event.target as HTMLTextAreaElement).value)}
          ></textarea>
          <label>
            <input
              type="checkbox"
              .checked=${props.forceAcknowledged}
              @change=${(event: Event) =>
                props.onForceAcknowledged((event.target as HTMLInputElement).checked)}
            />
            ${t("skillHubPage.forceConfirm")}
          </label>
          <button
            class="btn danger"
            ?disabled=${props.busy ||
            !props.forceAcknowledged ||
            props.forceReason.trim().length < 10}
            @click=${props.onForcePublish}
          >
            ${t("skillHubPage.forcePublish")}
          </button>
        </div>`
      : nothing}
    ${typeof props.detail.owner?.revision === "number"
      ? html`<div class="skill-hub-management__group">
          <div>
            <strong>${t("skillHubPage.deleteSkill")}</strong>
            <p>${t("skillHubPage.deleteSkillHelp")}</p>
          </div>
          <button class="btn danger" ?disabled=${props.busy} @click=${props.onDeleteSkill}>
            ${t("skillHubPage.deleteSkill")}
          </button>
        </div>`
      : nothing}
  </section>`;
}
