import { html, nothing } from "lit";
import { renderSettingsStatus } from "../components/settings-ui.ts";
import { platformClawT as t } from "./i18n.ts";
import type { OrganizationMemberRole, OrganizationScope } from "./organization-api.ts";

export function organizationScopeLabel(
  scope: Pick<OrganizationScope, "name" | "externalKey">,
  lineage: readonly Pick<OrganizationScope, "name">[],
): string {
  const path = lineage.length > 0 ? lineage.map((entry) => entry.name).join(" / ") : scope.name;
  // Directory IDs distinguish separate organizations even when every path name matches.
  return scope.externalKey ? `${path} (${scope.externalKey})` : path;
}

export function renderOrganizationManagedBadge(scope: {
  managedBy?: "ldap-login";
  manualRole?: OrganizationMemberRole;
}) {
  return scope.managedBy
    ? html`<span
        class="platformclaw-organization-statuses"
        title=${t("platformClaw.organization.automatic.description")}
      >
        ${renderSettingsStatus({ kind: "muted", label: t("platformClaw.organization.automatic") })}
        ${scope.manualRole
          ? renderSettingsStatus({
              kind: "muted",
              label: t("platformClaw.organization.manualRetained"),
            })
          : nothing}
      </span>`
    : nothing;
}
