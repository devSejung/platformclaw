import { html, nothing, type TemplateResult } from "lit";
import { renderSettingsRow } from "../components/settings-ui.ts";
import { platformClawT as t } from "./i18n.ts";
import type { OrganizationScopeResult } from "./organization-api.ts";
import {
  organizationScopeLabel,
  renderOrganizationManagedBadge,
} from "./organization-scope-label.ts";

export function renderOrganizationScopePicker(options: {
  scopes: readonly OrganizationScopeResult[];
  selectedScopeId: string;
  hasMore: boolean;
  onSearch(query: string): void;
  onSelect(scopeId: string): void;
}): TemplateResult {
  const manageable = options.scopes.filter(
    (scope) =>
      scope.capabilities.canManageMembers ||
      scope.capabilities.canManageStructure ||
      scope.capabilities.canManageLeaders,
  );
  return renderSettingsRow({
    title: t("platformClaw.organization.management.scope"),
    description: html`${t("platformClaw.organization.management.scopeDescription")}
    ${renderOrganizationManagedBadge(
      manageable.find((scope) => scope.id === options.selectedScopeId) ?? {},
    )}`,
    stacked: true,
    control: html`<div class="platformclaw-organization-picker">
      <form
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget as HTMLFormElement).get("query");
          options.onSearch(typeof value === "string" ? value.trim() : "");
        }}
      >
        <label class="field">
          <span class="sr-only">${t("platformClaw.organization.management.search")}</span>
          <input name="query" maxlength="128" />
        </label>
        <button class="btn btn--sm" type="submit">${t("platformClaw.organization.search")}</button>
      </form>
      ${manageable.length === 0
        ? html`<span class="muted"
            >${t("platformClaw.organization.management.noneDescription")}</span
          >`
        : html`<select
            class="settings-select"
            aria-label=${t("platformClaw.organization.management.scope")}
            @change=${(event: Event) =>
              options.onSelect((event.currentTarget as HTMLSelectElement).value)}
          >
            ${manageable.map(
              (scope) => html`<option
                value=${scope.id}
                ?selected=${scope.id === options.selectedScopeId}
              >
                ${organizationScopeLabel(scope, scope.lineage)}
              </option>`,
            )}
          </select>`}
      ${options.hasMore
        ? html`<span class="muted" role="status"
            >${t("platformClaw.organization.management.searchHasMore")}</span
          >`
        : nothing}
    </div>`,
  });
}
