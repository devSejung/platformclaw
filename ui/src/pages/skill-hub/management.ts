import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  PlatformClawSkillHubDetail,
  PlatformClawSkillHubManagementUser,
} from "../../platformclaw/skill-hub.ts";

export function renderSkillHubManagement(props: {
  detail: PlatformClawSkillHubDetail | null;
  ownerQuery: string;
  accessQuery: string;
  ownerCandidates: PlatformClawSkillHubManagementUser[];
  accessCandidates: PlatformClawSkillHubManagementUser[];
  selectedOwnerUserId: string;
  selectedAccessUserId: string;
  forceReason: string;
  forceAcknowledged: boolean;
  busy: boolean;
  onOwnerQuery: (value: string) => void;
  onSelectOwner: (user: PlatformClawSkillHubManagementUser) => void;
  onTransferOwner: () => void;
  onAccessQuery: (value: string) => void;
  onSelectAccess: (user: PlatformClawSkillHubManagementUser) => void;
  onGrantAccess: () => void;
  onRemoveAccess: (userId: string) => void;
  onForceReason: (value: string) => void;
  onForceAcknowledged: (value: boolean) => void;
  onForcePublish: () => void;
}) {
  if (!props.detail?.canManage) {
    return nothing;
  }
  return html`<section class="skill-hub-management">
    <h3>${t("skillHubPage.management")}</h3>
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
        <input
          .value=${props.ownerQuery}
          placeholder=${t("skillHubPage.searchUsers")}
          @input=${(event: Event) => props.onOwnerQuery((event.target as HTMLInputElement).value)}
        />
        ${props.ownerCandidates.length > 0
          ? html`<div class="skill-hub-user-results">
              ${props.ownerCandidates.map(
                (user) => html`<button
                  class="btn btn--sm"
                  @click=${() => props.onSelectOwner(user)}
                >
                  ${user.displayName ?? user.accountId} · ${user.accountId}
                </button>`,
              )}
            </div>`
          : nothing}
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
        <input
          .value=${props.accessQuery}
          placeholder=${t("skillHubPage.searchUsers")}
          @input=${(event: Event) => props.onAccessQuery((event.target as HTMLInputElement).value)}
        />
        ${props.accessCandidates.length > 0
          ? html`<div class="skill-hub-user-results">
              ${props.accessCandidates.map(
                (user) => html`<button
                  class="btn btn--sm"
                  @click=${() => props.onSelectAccess(user)}
                >
                  ${user.displayName ?? user.accountId} · ${user.accountId}
                </button>`,
              )}
            </div>`
          : nothing}
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
  </section>`;
}
