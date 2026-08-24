import { html, nothing, type TemplateResult } from "lit";
import { renderSettingsRow, renderSettingsSection } from "../components/settings-ui.ts";
import { platformClawT as t } from "./i18n.ts";
import type { OrganizationContext, OrganizationScopeResult } from "./organization-api.ts";

function lineageLabel(scope: OrganizationScopeResult): string {
  return scope.lineage.map((entry) => entry.name).join(" / ");
}

function contextLineageLabel(scopeId: string, context: OrganizationContext): string | undefined {
  const explicit = context.directScopeLineages.find((entry) => entry.scopeId === scopeId)?.lineage;
  if (explicit?.length) {
    return explicit.map((scope) => scope.name).join(" / ");
  }
  if (context.primaryScope?.id === scopeId && context.primaryScopeLineage.length > 0) {
    return context.primaryScopeLineage.map((scope) => scope.name).join(" / ");
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
  return names.length > 0 ? names.join(" / ") : undefined;
}

export function renderOrganizationOverview(options: {
  context: OrganizationContext | null;
  scopes: readonly OrganizationScopeResult[];
  scopesHasMore: boolean;
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
            title: contextLineageLabel(scope.id, context) ?? scope.name,
            description: `${t(`platformClaw.organization.role.${membership.role}`)} · ${t(
              `platformClaw.organization.kind.${scope.kind}`,
            )}`,
          }),
        )}
    ${renderSettingsRow({
      title: t("platformClaw.organization.my.primary"),
      description: t("platformClaw.organization.my.primaryDescription"),
      control: html`<select
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
        class="settings-row__controls"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const query = new FormData(event.currentTarget as HTMLFormElement).get("scopeQuery");
          options.onSearch(typeof query === "string" ? query.trim() : "");
        }}
      >
        <label class="field">
          <span class="sr-only">${t("platformClaw.organization.tree.search")}</span>
          <input name="scopeQuery" maxlength="128" />
        </label>
        <button class="btn btn--sm" type="submit">${t("platformClaw.organization.search")}</button>
      </form>
      ${options.scopes.length === 0
        ? renderSettingsRow({
            title: t("platformClaw.organization.tree.empty"),
            description: t("platformClaw.organization.tree.emptyDescription"),
          })
        : options.scopes.map((scope) =>
            renderSettingsRow({
              title: lineageLabel(scope),
              description: t(`platformClaw.organization.kind.${scope.kind}`),
            }),
          )}
      ${options.scopesHasMore
        ? html`<p class="muted" role="status">${t("platformClaw.organization.tree.truncated")}</p>`
        : nothing}`,
  );
  return html`${myOrganization}${tree}`;
}
