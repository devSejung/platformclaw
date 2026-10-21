import { html, nothing, type TemplateResult } from "lit";
import { renderSettingsRow, renderSettingsSection } from "../components/settings-ui.ts";
import { platformClawT as t } from "./i18n.ts";
import type { OrganizationContext, OrganizationScopeResult } from "./organization-api.ts";
import {
  organizationScopeLabel,
  renderOrganizationManagedBadge,
} from "./organization-scope-label.ts";

function contextLineageLabel(scopeId: string, context: OrganizationContext): string | undefined {
  const explicit = context.directScopeLineages.find((entry) => entry.scopeId === scopeId)?.lineage;
  if (explicit?.length) {
    return organizationScopeLabel(explicit[explicit.length - 1]!, explicit);
  }
  if (context.primaryScope?.id === scopeId && context.primaryScopeLineage.length > 0) {
    return organizationScopeLabel(context.primaryScope, context.primaryScopeLineage);
  }
  const byId = new Map(context.effectiveScopes.map((access) => [access.scope.id, access.scope]));
  const names: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(scopeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = current.parentScopeId ? byId.get(current.parentScopeId) : undefined;
  }
  const scope = byId.get(scopeId);
  return scope
    ? organizationScopeLabel(
        scope,
        names.map((name) => ({ name })),
      )
    : undefined;
}

export function renderOrganizationOverview(options: {
  context: OrganizationContext | null;
  scopes: readonly OrganizationScopeResult[];
  scopesHasMore: boolean;
  searching?: boolean;
  busy: boolean;
  onPrimaryChange(scopeId: string): void;
  onSearch(query: string): void;
}): TemplateResult | typeof nothing {
  const context = options.context;
  if (!context) {
    return nothing;
  }
  const directScopes = context.directMemberships.flatMap((membership) => {
    const access = context.effectiveScopes.find(
      (candidate) => candidate.scope.id === membership.scopeId,
    );
    return access ? [{ membership, scope: access.scope }] : [];
  });
  const primaryScopes = [
    ...directScopes.map(({ scope }) => scope),
    ...(context.primaryScope &&
    !directScopes.some(({ scope }) => scope.id === context.primaryScope?.id)
      ? [context.primaryScope]
      : []),
  ];
  const myOrganization = renderSettingsSection(
    {
      title: t("platformClaw.organization.my.title"),
      description: t("platformClaw.organization.my.description"),
    },
    html`${directScopes.length === 0
      ? renderSettingsRow({
          title: t("platformClaw.organization.my.unaffiliated"),
          description: t("platformClaw.organization.my.unaffiliatedDescription"),
        })
      : directScopes.map(({ membership, scope }) =>
          renderSettingsRow({
            title: html`${contextLineageLabel(scope.id, context) ?? scope.name}
            ${renderOrganizationManagedBadge(scope)}`,
            description: html`${t(`platformClaw.organization.role.${membership.role}`)} ·
            ${t(`platformClaw.organization.kind.${scope.kind}`)}
            ${renderOrganizationManagedBadge(membership)}`,
          }),
        )}
    ${renderSettingsRow({
      title: t("platformClaw.organization.my.primary"),
      description: t("platformClaw.organization.my.primaryDescription"),
      control: html`<select
        class="settings-select"
        aria-label=${t("platformClaw.organization.my.primary")}
        ?disabled=${options.busy}
        @change=${(event: Event) =>
          options.onPrimaryChange((event.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">${t("platformClaw.organization.my.noPrimary")}</option>
        ${primaryScopes.map(
          (scope) => html`<option
            value=${scope.id}
            ?selected=${context.primaryScope?.id === scope.id}
          >
            ${contextLineageLabel(scope.id, context) ?? scope.name}
          </option>`,
        )}
      </select>`,
    })}
    ${context.primaryScope &&
    !directScopes.some(({ scope }) => scope.id === context.primaryScope?.id)
      ? renderSettingsRow({
          title: t("platformClaw.organization.my.primaryCurrent"),
          description:
            contextLineageLabel(context.primaryScope.id, context) ?? context.primaryScope.name,
        })
      : nothing}
    ${renderSettingsRow({
      title: t("platformClaw.organization.my.effective"),
      description:
        context.effectiveScopes.length > 0
          ? context.effectiveScopes
              .map(
                (access) =>
                  `${access.scope.name} (${t(`platformClaw.organization.access.${access.source}`)})`,
              )
              .join(" · ")
          : t("platformClaw.organization.my.noEffective"),
    })}
    ${context.directMembershipsHasMore || context.effectiveScopesHasMore
      ? html`<p class="muted" role="status">${t("platformClaw.organization.my.truncated")}</p>`
      : nothing}`,
  );
  const tree = renderSettingsSection(
    {
      title: t("platformClaw.organization.tree.title"),
      description: t("platformClaw.organization.tree.description"),
    },
    html`<form
        class="organization-search"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const query = new FormData(event.currentTarget as HTMLFormElement).get("scopeQuery");
          options.onSearch(typeof query === "string" ? query.trim() : "");
        }}
      >
        <label class="field">
          <span class="sr-only">${t("platformClaw.organization.tree.search")}</span>
          <input class="settings-input" name="scopeQuery" maxlength="128" />
        </label>
        <button class="btn" type="submit" ?disabled=${options.searching || options.busy}>
          ${t("platformClaw.organization.search")}
        </button>
      </form>
      ${options.searching
        ? html`<p class="muted" role="status">${t("platformClaw.organization.loading")}</p>`
        : nothing}
      ${options.scopes.length === 0
        ? renderSettingsRow({
            title: t("platformClaw.organization.tree.empty"),
            description: t("platformClaw.organization.tree.emptyDescription"),
          })
        : options.scopes.map((scope) =>
            renderSettingsRow({
              title: html`${organizationScopeLabel(scope, scope.lineage)}
              ${renderOrganizationManagedBadge(scope)}`,
              description: t(`platformClaw.organization.kind.${scope.kind}`),
            }),
          )}
      ${options.scopesHasMore
        ? html`<p class="muted" role="status">${t("platformClaw.organization.tree.truncated")}</p>`
        : nothing}`,
  );
  return html`${myOrganization}${tree}`;
}
