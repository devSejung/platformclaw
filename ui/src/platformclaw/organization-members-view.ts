import { html, nothing, type TemplateResult } from "lit";
import { renderSettingsRow } from "../components/settings-ui.ts";
import { platformClawT as t } from "./i18n.ts";
import { renderMemberTargetSearch } from "./member-target-search.ts";
import type {
  OrganizationManagement,
  OrganizationMemberRole,
  OrganizationScopeResult,
  OrganizationUserSearch,
} from "./organization-api.ts";

export function renderOrganizationAddMember(options: {
  selected?: OrganizationScopeResult;
  users: OrganizationUserSearch["items"];
  hasMore: boolean;
  busy: boolean;
  onSearch(query: string): void;
  onAdd(userId: string, target: string): void;
}): TemplateResult | typeof nothing {
  if (!options.selected?.capabilities.canManageMembers) {
    return nothing;
  }
  return renderSettingsRow({
    title: t("platformClaw.organization.members.add"),
    description: t("platformClaw.organization.members.addDescription"),
    control: renderMemberTargetSearch({
      label: t("platformClaw.organization.members.search"),
      searchLabel: t("platformClaw.organization.search"),
      moreLabel: t("platformClaw.organization.members.searchHasMore"),
      busy: options.busy,
      hasMore: options.hasMore,
      items: options.users.map((user) => ({
        id: user.id,
        label: user.displayName ?? user.accountId,
        detail: user.accountId,
        action: user.currentRole
          ? t(`platformClaw.organization.role.${user.currentRole}`)
          : t("platformClaw.organization.members.addAction"),
        disabled: Boolean(user.currentRole),
      })),
      onSearch: (query) => options.onSearch(query),
      onSelect: (id) => {
        const user = options.users.find((entry) => entry.id === id)!;
        options.onAdd(id, user.displayName ?? user.accountId);
      },
    }),
  });
}

export function renderOrganizationRoster(options: {
  selected?: OrganizationScopeResult;
  management: OrganizationManagement | null;
  actorUserId: string;
  busy: boolean;
  onRoleChange(
    userId: string,
    target: string,
    role: OrganizationMemberRole,
    expectedRole: OrganizationMemberRole,
  ): boolean;
  onRemove(userId: string, target: string, expectedRole: OrganizationMemberRole): void;
  onLoadMore(offset: number): void;
}): TemplateResult | typeof nothing {
  if (!options.selected?.capabilities.canManageMembers || !options.management) {
    return nothing;
  }
  return html`
    ${options.management.members.length === 0
      ? renderSettingsRow({
          title: t("platformClaw.organization.members.empty"),
          description: t("platformClaw.organization.members.emptyDescription"),
        })
      : options.management.members.map((member) =>
          renderSettingsRow({
            title: member.user.displayName ?? member.user.accountId,
            description: member.user.accountId,
            control: html`<div class="settings-row__controls">
              <select
                aria-label=${t("platformClaw.organization.members.role")}
                ?disabled=${options.busy || !options.selected?.capabilities.canManageLeaders}
                @change=${(event: Event) => {
                  const select = event.currentTarget as HTMLSelectElement;
                  if (
                    !options.onRoleChange(
                      member.user.id,
                      member.user.displayName ?? member.user.accountId,
                      select.value as OrganizationMemberRole,
                      member.role,
                    )
                  ) {
                    select.value = member.role;
                  }
                }}
              >
                <option value="member" ?selected=${member.role === "member"}>
                  ${t("platformClaw.organization.role.member")}
                </option>
                <option value="leader" ?selected=${member.role === "leader"}>
                  ${t("platformClaw.organization.role.leader")}
                </option>
              </select>
              ${options.selected?.capabilities.canManageLeaders ||
              (member.role === "member" && member.user.id !== options.actorUserId)
                ? html`<button
                    class="btn btn--sm"
                    ?disabled=${options.busy}
                    @click=${() =>
                      options.onRemove(
                        member.user.id,
                        member.user.displayName ?? member.user.accountId,
                        member.role,
                      )}
                  >
                    ${t("platformClaw.organization.members.remove")}
                  </button>`
                : nothing}
            </div>`,
          }),
        )}
    ${options.management.nextOffset !== undefined
      ? html`<button
          class="btn btn--sm"
          ?disabled=${options.busy}
          @click=${() => options.onLoadMore(options.management!.nextOffset!)}
        >
          ${t("platformClaw.organization.members.more")}
        </button>`
      : nothing}
  `;
}
