import { html, nothing, type TemplateResult } from "lit";
import { renderSettingsRow } from "../components/settings-ui.ts";
import { platformClawT as t } from "./i18n.ts";
import type { OrganizationScopeKind, OrganizationScopeResult } from "./organization-api.ts";

function lineageLabel(scope: OrganizationScopeResult): string {
  return scope.lineage.map((entry) => entry.name).join(" / ");
}

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function renderOrganizationStructure(options: {
  scopes: readonly OrganizationScopeResult[];
  selected?: OrganizationScopeResult;
  canCreateRoot: boolean;
  busy: boolean;
  onCreate(params: { kind: OrganizationScopeKind; name: string; parentScopeId?: string }): void;
  onRename(): void;
  onArchive(): void;
}): TemplateResult | typeof nothing {
  if (
    !options.canCreateRoot &&
    !options.scopes.some((scope) => scope.capabilities.canManageStructure)
  ) {
    return nothing;
  }
  const createForm = (
    kind: OrganizationScopeKind,
    parents: readonly OrganizationScopeResult[],
  ) => html`<form
    class="settings-row__controls platformclaw-organization-create-form"
    aria-label=${t(`platformClaw.organization.structure.create.${kind}`)}
    @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const name = formText(data, "name");
      const parentScopeId = formText(data, "parentScopeId");
      options.onCreate({ kind, name, ...(kind === "team" ? {} : { parentScopeId }) });
    }}
  >
    <label class="field">
      <span>${t(`platformClaw.organization.kind.${kind}`)}</span>
      <input name="name" maxlength="120" required />
    </label>
    ${kind === "team"
      ? nothing
      : html`<label class="field">
          <span>${t("platformClaw.organization.structure.parent")}</span>
          <select name="parentScopeId" required>
            <option value="">${t("platformClaw.organization.structure.chooseParent")}</option>
            ${parents.map(
              (scope) => html`<option value=${scope.id}>${lineageLabel(scope)}</option>`,
            )}
          </select>
        </label>`}
    <button class="btn btn--sm" type="submit" ?disabled=${options.busy}>
      ${t("platformClaw.organization.structure.createAction")}
    </button>
  </form>`;
  const structureScopes = options.scopes.filter((scope) => scope.capabilities.canManageStructure);
  const teamParents = structureScopes.filter((scope) => scope.kind === "team");
  const groupParents = structureScopes.filter((scope) => scope.kind === "group");
  return html`
    ${renderSettingsRow({
      title: t("platformClaw.organization.structure.create"),
      description: t("platformClaw.organization.structure.createDescription"),
      control: html`<div class="platformclaw-organization-create-grid">
        ${options.canCreateRoot ? createForm("team", []) : nothing}
        ${teamParents.length > 0 ? createForm("group", teamParents) : nothing}
        ${groupParents.length > 0 ? createForm("part", groupParents) : nothing}
      </div>`,
    })}
    ${options.selected?.capabilities.canManageStructure
      ? renderSettingsRow({
          title: t("platformClaw.organization.structure.selected"),
          description: lineageLabel(options.selected),
          control: html`<div class="settings-row__controls">
            <button
              class="btn btn--sm"
              ?disabled=${options.busy}
              @click=${() => options.onRename()}
            >
              ${t("platformClaw.organization.structure.rename")}
            </button>
            <button
              class="btn btn--sm danger"
              ?disabled=${options.busy}
              @click=${() => options.onArchive()}
            >
              ${t("platformClaw.organization.structure.archive")}
            </button>
          </div>`,
        })
      : nothing}
  `;
}
