import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { PlatformClawSkillHubDetail } from "../../platformclaw/skill-hub.ts";

export function renderSkillHubManagement(props: {
  detail: PlatformClawSkillHubDetail | null;
  ownerUserId: string;
  accessUserId: string;
  forceReason: string;
  forceAcknowledged: boolean;
  busy: boolean;
  onOwnerUserId: (value: string) => void;
  onTransferOwner: () => void;
  onAccessUserId: (value: string) => void;
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
        <p>${props.detail.owner?.userId ?? t("skillHubPage.ownerUnassigned")}</p>
      </div>
      <div class="skill-hub-management__action">
        <input
          .value=${props.ownerUserId}
          placeholder=${t("skillHubPage.employeeId")}
          @input=${(event: Event) => props.onOwnerUserId((event.target as HTMLInputElement).value)}
        />
        <button
          class="btn btn--sm"
          ?disabled=${props.busy || !props.ownerUserId.trim()}
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
          .value=${props.accessUserId}
          placeholder=${t("skillHubPage.employeeId")}
          @input=${(event: Event) => props.onAccessUserId((event.target as HTMLInputElement).value)}
        />
        <button
          class="btn btn--sm"
          ?disabled=${props.busy || !props.accessUserId.trim()}
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
