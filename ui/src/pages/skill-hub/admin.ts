import { html, nothing } from "lit";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import type {
  PlatformClawManagedScope,
  PlatformClawSkillHubNamespaceBinding,
  PlatformClawSkillHubUnassignedSkill,
} from "../../platformclaw/skill-hub.ts";
import { skillHubScopeKindLabel, skillHubVisibilityLabel } from "./labels.ts";

export type SkillHubAdminDraft = {
  namespace: string;
  scopeKind: "global" | "team" | "group" | "part";
  scopeId: string;
  visibilityCeiling: "PUBLIC" | "NAMESPACE_ONLY" | "PRIVATE";
  reason: string;
};

export type SkillHubAdminAction = {
  binding: PlatformClawSkillHubNamespaceBinding;
  action: "activate" | "restrict" | "remove";
  reason: string;
};

export function skillHubScopeLineageLabel(
  scopeId: string,
  scopes: readonly PlatformClawManagedScope[],
): string {
  const byId = new Map(scopes.map((scope) => [scope.id, scope]));
  const names: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(scopeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.push(current.name);
    current = current.parentScopeId ? byId.get(current.parentScopeId) : undefined;
  }
  return names.reverse().join(" / ") || scopeId;
}

export function renderSkillHubAdmin(props: {
  open: boolean;
  loading: boolean;
  busy: boolean;
  bindings: PlatformClawSkillHubNamespaceBinding[];
  scopes: PlatformClawManagedScope[];
  unassigned: PlatformClawSkillHubUnassignedSkill[];
  draft: SkillHubAdminDraft;
  pendingAction: SkillHubAdminAction | null;
  onClose: () => void;
  onDraft: (draft: SkillHubAdminDraft) => void;
  onSave: () => void;
  onRequestAction: (action: SkillHubAdminAction) => void;
  onPendingAction: (action: SkillHubAdminAction | null) => void;
  onConfirmAction: () => void;
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
                    <option value="global">${t("skillHubPage.scopeGlobal")}</option>
                    <option value="team">${t("skillHubPage.scopeTeam")}</option>
                    <option value="group">${t("skillHubPage.scopeGroup")}</option>
                    <option value="part">${t("skillHubPage.scopePart")}</option>
                  </select>
                </label>
                ${props.draft.scopeKind === "global"
                  ? html`<p class="skill-hub-state">${t("skillHubPage.globalRestrictedHelp")}</p>`
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
                          (scope) => html`<option value=${scope.id}>
                            ${skillHubScopeLineageLabel(scope.id, props.scopes)}
                          </option>`,
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
                <label class="field">
                  <span>${t("skillHubPage.changeReason")}</span>
                  <input
                    .value=${props.draft.reason}
                    @input=${(event: Event) =>
                      props.onDraft({
                        ...props.draft,
                        reason: (event.target as HTMLInputElement).value,
                      })}
                  />
                </label>
                <button
                  class="btn primary"
                  ?disabled=${props.busy ||
                  !props.draft.namespace.trim() ||
                  !props.draft.reason.trim() ||
                  (props.draft.scopeKind !== "global" && !props.draft.scopeId)}
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
                          ${binding.accessState === "restricted"
                            ? html`<span class="chip">${t("skillHubPage.globalRestricted")}</span>`
                            : nothing}
                          <small
                            >${skillHubScopeKindLabel(binding.scopeKind)}${binding.scopeId
                              ? ` · ${
                                  props.scopes.find((scope) => scope.id === binding.scopeId)
                                    ? skillHubScopeLineageLabel(binding.scopeId, props.scopes)
                                    : binding.scopeId
                                }`
                              : ""}
                            · ${skillHubVisibilityLabel(binding.visibilityCeiling)}</small
                          >
                        </div>
                        ${binding.scopeKind === "global"
                          ? html`<button
                              class="btn btn--sm"
                              ?disabled=${props.busy}
                              @click=${() =>
                                props.onRequestAction({
                                  binding,
                                  action:
                                    binding.accessState === "active" ? "restrict" : "activate",
                                  reason: "",
                                })}
                            >
                              ${binding.accessState === "active"
                                ? t("skillHubPage.restrictGlobal")
                                : t("skillHubPage.activateGlobal")}
                            </button>`
                          : nothing}
                        <button
                          class="btn btn--sm danger"
                          ?disabled=${props.busy}
                          @click=${() =>
                            props.onRequestAction({ binding, action: "remove", reason: "" })}
                        >
                          ${t("skillHubPage.removeBinding")}
                        </button>
                      </article>`,
                    )}
              </div>
              ${props.pendingAction
                ? html`<section class="skill-hub-admin__confirmation">
                    <strong>${t("skillHubPage.confirmNamespaceAction")}</strong>
                    <p>
                      ${props.pendingAction.binding.namespace} ·
                      ${props.pendingAction.action === "activate"
                        ? t("skillHubPage.activateGlobal")
                        : props.pendingAction.action === "restrict"
                          ? t("skillHubPage.restrictGlobal")
                          : t("skillHubPage.removeBinding")}
                    </p>
                    <label class="field">
                      <span>${t("skillHubPage.changeReason")}</span>
                      <input
                        .value=${props.pendingAction.reason}
                        @input=${(event: Event) =>
                          props.onPendingAction({
                            ...props.pendingAction!,
                            reason: (event.target as HTMLInputElement).value,
                          })}
                      />
                    </label>
                    <div>
                      <button class="btn btn--sm" @click=${() => props.onPendingAction(null)}>
                        ${t("common.cancel")}
                      </button>
                      <button
                        class="btn btn--sm danger"
                        ?disabled=${props.busy || !props.pendingAction.reason.trim()}
                        @click=${props.onConfirmAction}
                      >
                        ${t("skillHubPage.confirmAction")}
                      </button>
                    </div>
                  </section>`
                : nothing}
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
                            · ${skillHubVisibilityLabel(skill.visibility)}</small
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
