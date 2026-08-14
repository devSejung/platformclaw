import { html, nothing } from "lit";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import type {
  PlatformClawManagedScope,
  PlatformClawSkillHubNamespaceBinding,
  PlatformClawSkillHubUnassignedSkill,
} from "../../platformclaw/skill-hub.ts";

export type SkillHubAdminDraft = {
  namespace: string;
  scopeKind: "team" | "group" | "part";
  scopeId: string;
  visibilityCeiling: "PUBLIC" | "NAMESPACE_ONLY" | "PRIVATE";
};

export function renderSkillHubAdmin(props: {
  open: boolean;
  loading: boolean;
  busy: boolean;
  bindings: PlatformClawSkillHubNamespaceBinding[];
  scopes: PlatformClawManagedScope[];
  unassigned: PlatformClawSkillHubUnassignedSkill[];
  draft: SkillHubAdminDraft;
  onClose: () => void;
  onDraft: (draft: SkillHubAdminDraft) => void;
  onSave: () => void;
  onRemove: (namespace: string) => void;
}) {
  if (!props.open) {
    return nothing;
  }
  const eligibleScopes = props.scopes.filter((scope) => scope.kind === props.draft.scopeKind);
  return html`<openclaw-modal-dialog
    label=${t("skillHubPage.admin")}
    @modal-cancel=${props.onClose}
  >
    <section class="skill-hub-dialog skill-hub-admin">
      <header class="skill-hub-dialog__header">
        <div>
          <h2>${t("skillHubPage.admin")}</h2>
          <p>${t("skillHubPage.adminHelp")}</p>
        </div>
        <button class="btn btn--sm" @click=${props.onClose}>${t("skillsPage.close")}</button>
      </header>
      ${props.loading
        ? html`<div class="skill-hub-state">${t("skillsPage.skillHub.loading")}</div>`
        : html`
            <section class="skill-hub-admin__section">
              <h3>${t("skillHubPage.namespaceBindings")}</h3>
              <div class="skill-hub-admin__form">
                <label class="field">
                  <span>${t("skillsPage.skillHub.namespace")}</span>
                  <input
                    .value=${props.draft.namespace}
                    @input=${(event: Event) =>
                      props.onDraft({
                        ...props.draft,
                        namespace: (event.target as HTMLInputElement).value,
                      })}
                  />
                </label>
                <label class="field">
                  <span>${t("skillHubPage.scope")}</span>
                  <select
                    .value=${props.draft.scopeKind}
                    @change=${(event: Event) => {
                      const scopeKind = (event.target as HTMLSelectElement)
                        .value as SkillHubAdminDraft["scopeKind"];
                      props.onDraft({ ...props.draft, scopeKind, scopeId: "" });
                    }}
                  >
                    <option value="team">${t("skillHubPage.scopeTeam")}</option>
                    <option value="group">${t("skillHubPage.scopeGroup")}</option>
                    <option value="part">${t("skillHubPage.scopePart")}</option>
                  </select>
                </label>
                ${props.draft.scopeKind === "team"
                  ? nothing
                  : html`<label class="field">
                      <span>${t("skillHubPage.scopeUnit")}</span>
                      <select
                        .value=${props.draft.scopeId}
                        @change=${(event: Event) =>
                          props.onDraft({
                            ...props.draft,
                            scopeId: (event.target as HTMLSelectElement).value,
                          })}
                      >
                        <option value="">${t("skillHubPage.chooseScope")}</option>
                        ${eligibleScopes.map(
                          (scope) => html`<option value=${scope.id}>${scope.name}</option>`,
                        )}
                      </select>
                    </label>`}
                <label class="field">
                  <span>${t("skillHubPage.visibilityCeiling")}</span>
                  <select
                    .value=${props.draft.visibilityCeiling}
                    @change=${(event: Event) =>
                      props.onDraft({
                        ...props.draft,
                        visibilityCeiling: (event.target as HTMLSelectElement)
                          .value as SkillHubAdminDraft["visibilityCeiling"],
                      })}
                  >
                    <option value="PUBLIC">${t("skillsPage.skillHub.public")}</option>
                    <option value="NAMESPACE_ONLY">
                      ${t("skillsPage.skillHub.namespaceOnly")}
                    </option>
                    <option value="PRIVATE">${t("skillsPage.skillHub.private")}</option>
                  </select>
                </label>
                <button
                  class="btn primary"
                  ?disabled=${props.busy ||
                  !props.draft.namespace.trim() ||
                  (props.draft.scopeKind !== "team" && !props.draft.scopeId)}
                  @click=${props.onSave}
                >
                  ${t("skillHubPage.saveBinding")}
                </button>
              </div>
              <div class="skill-hub-admin__list">
                ${props.bindings.length === 0
                  ? html`<p>${t("skillHubPage.noBindings")}</p>`
                  : props.bindings.map(
                      (binding) => html`<article>
                        <div>
                          <strong>${binding.namespace}</strong>
                          <small
                            >${binding.scopeKind}${binding.scopeId
                              ? ` · ${
                                  props.scopes.find((scope) => scope.id === binding.scopeId)
                                    ?.name ?? binding.scopeId
                                }`
                              : ""}
                            · ${binding.visibilityCeiling}</small
                          >
                        </div>
                        <button
                          class="btn btn--sm danger"
                          ?disabled=${props.busy}
                          @click=${() => props.onRemove(binding.namespace)}
                        >
                          ${t("skillHubPage.removeBinding")}
                        </button>
                      </article>`,
                    )}
              </div>
            </section>
            <section class="skill-hub-admin__section">
              <h3>${t("skillHubPage.unassignedOwners")}</h3>
              <p>${t("skillHubPage.unassignedOwnersHelp")}</p>
              <div class="skill-hub-admin__list">
                ${props.unassigned.length === 0
                  ? html`<p>${t("skillHubPage.noUnassignedOwners")}</p>`
                  : props.unassigned.map(
                      (skill) => html`<article>
                        <div>
                          <strong>${skill.namespace}/${skill.slug}</strong>
                          <small
                            >${t("skillHubPage.versionValue", {
                              version: skill.currentVersion,
                            })}
                            · ${skill.visibility}</small
                          >
                        </div>
                      </article>`,
                    )}
              </div>
            </section>
          `}
    </section>
  </openclaw-modal-dialog>`;
}
