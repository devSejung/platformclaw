import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  PlatformClawSkillHubConfig,
  PlatformClawSkillHubSharing,
  PlatformClawSkillHubSharingDetail,
} from "../../platformclaw/skill-hub.ts";
import { skillHubScopeLineageLabel } from "./scope-lineage.ts";
import "./user-picker.ts";

export function initialSkillHubSharing(): PlatformClawSkillHubSharingDetail {
  return { mode: "PUBLIC", userIds: [], scopeIds: [], users: [], scopes: [] };
}

export function skillHubSharingRequest(
  draft: PlatformClawSkillHubSharingDetail,
): PlatformClawSkillHubSharing {
  return {
    mode: draft.mode,
    userIds: draft.mode === "SELECTED" ? [...draft.userIds] : [],
    scopeIds: draft.mode === "SELECTED" ? [...draft.scopeIds] : [],
  };
}

export function skillHubSharingInvalid(draft: PlatformClawSkillHubSharing): boolean {
  return draft.mode === "SELECTED" && draft.userIds.length === 0 && draft.scopeIds.length === 0;
}

export function renderSkillHubSharing(props: {
  draft: PlatformClawSkillHubSharingDetail;
  config: PlatformClawSkillHubConfig | null;
  disabled: boolean;
  onChange: (draft: PlatformClawSkillHubSharingDetail) => void;
}) {
  const { draft } = props;
  const unavailableScopes = props.config
    ? draft.scopeIds.filter((id) => !props.config!.scopes.some((scope) => scope.id === id))
    : [];
  return html`<section class="skill-hub-sharing">
    <label class="field">
      <span>${t("skillHubPage.sharing")}</span>
      <select
        name="sharing"
        .value=${draft.mode}
        ?disabled=${props.disabled}
        @change=${(event: Event) =>
          props.onChange({
            ...draft,
            mode: (event.target as HTMLSelectElement).value as PlatformClawSkillHubSharing["mode"],
          })}
      >
        <option value="PUBLIC" ?selected=${draft.mode === "PUBLIC"}>
          ${t("skillHubPage.sharingPublic")}
        </option>
        <option value="SELECTED" ?selected=${draft.mode === "SELECTED"}>
          ${t("skillHubPage.sharingSelected")}
        </option>
        <option value="PRIVATE" ?selected=${draft.mode === "PRIVATE"}>
          ${t("skillHubPage.sharingPrivate")}
        </option>
      </select>
    </label>
    <small
      >${t(
        draft.mode === "PUBLIC"
          ? "skillHubPage.sharingPublicHelp"
          : draft.mode === "PRIVATE"
            ? "skillHubPage.sharingPrivateHelp"
            : "skillHubPage.sharingSelectedHelp",
      )}</small
    >
    ${draft.mode === "SELECTED"
      ? html`
          <openclaw-skill-hub-user-picker
            purpose="access"
            .disabled=${props.disabled}
            .onSelect=${(user: PlatformClawSkillHubSharingDetail["users"][number] | null) => {
              if (user && !draft.userIds.includes(user.id)) {
                props.onChange({
                  ...draft,
                  userIds: [...draft.userIds, user.id],
                  users: [...draft.users, user],
                });
              }
            }}
          ></openclaw-skill-hub-user-picker>
          <div class="skill-hub-access-list">
            ${draft.userIds.map((id) => {
              const user = draft.users.find((candidate) => candidate.id === id);
              return html`<span
                >${user?.displayName ?? user?.accountId ?? id}<button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${props.disabled}
                  aria-label=${t("skillHubPage.removeRecipient")}
                  @click=${() =>
                    props.onChange({
                      ...draft,
                      userIds: draft.userIds.filter((value) => value !== id),
                      users: draft.users.filter((value) => value.id !== id),
                    })}
                >
                  ×
                </button></span
              >`;
            })}
          </div>
          <fieldset ?disabled=${props.disabled} class="skill-hub-sharing__scopes">
            <legend>${t("skillHubPage.organizations")}</legend>
            ${props.config?.scopes.map(
              (scope) => html`<label
                ><input
                  type="checkbox"
                  name="scopeIds"
                  value=${scope.id}
                  .checked=${draft.scopeIds.includes(scope.id)}
                  @change=${(event: Event) => {
                    const checked = (event.target as HTMLInputElement).checked;
                    const scopeIds = draft.scopeIds.filter((value) => value !== scope.id);
                    const scopes = draft.scopes.filter((value) => value.id !== scope.id);
                    props.onChange({
                      ...draft,
                      scopeIds: checked ? [...scopeIds, scope.id] : scopeIds,
                      scopes: checked ? [...scopes, scope] : scopes,
                    });
                  }}
                />${skillHubScopeLineageLabel(scope.id, props.config!.scopes)}</label
              >`,
            )}
          </fieldset>
          ${unavailableScopes.length
            ? html`<div class="skill-hub-access-list skill-hub-unavailable-scopes">
                <small role="status">${t("skillHubPage.unavailableOrganizationsHelp")}</small>
                ${unavailableScopes.map((id) => {
                  const name = draft.scopes.find((scope) => scope.id === id)?.name ?? id;
                  return html`<span>
                    ${name} · ${t("skillHubPage.organizationUnavailable")}
                    <button
                      type="button"
                      class="btn btn--sm"
                      ?disabled=${props.disabled}
                      aria-label=${t("skillHubPage.removeUnavailableOrganization", { name })}
                      @click=${() =>
                        props.onChange({
                          ...draft,
                          scopeIds: draft.scopeIds.filter((value) => value !== id),
                          scopes: draft.scopes.filter((scope) => scope.id !== id),
                        })}
                    >
                      ×
                    </button>
                  </span>`;
                })}
              </div>`
            : nothing}
          ${skillHubSharingInvalid(draft)
            ? html`<p role="status">${t("skillHubPage.chooseRecipients")}</p>`
            : nothing}
        `
      : nothing}
  </section>`;
}
