import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { renderHubTabs } from "../components/hub-tabs.ts";
import { renderSettingsSection } from "../components/settings-ui.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "../styles/platformclaw-organization.css";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import {
  renderOrganizationActionDialog,
  type OrganizationPendingAction,
} from "./organization-action-dialog.ts";
import {
  PlatformClawOrganizationApi,
  PlatformClawOrganizationApiError,
  type OrganizationContext,
  type OrganizationManagement,
  type OrganizationScopeResult,
  type OrganizationUserSearch,
} from "./organization-api.ts";
import { organizationErrorMessage } from "./organization-errors.ts";
import {
  renderOrganizationAddMember,
  renderOrganizationRoster,
} from "./organization-members-view.ts";
import { renderOrganizationOverview } from "./organization-overview-view.ts";
import { renderOrganizationScopePicker } from "./organization-scope-picker.ts";
import { renderOrganizationStructure } from "./organization-structure-view.ts";

function lineageLabel(scope: OrganizationScopeResult): string {
  return scope.lineage.map((entry) => entry.name).join(" / ");
}

class PlatformClawOrganizationPage extends OpenClawLightDomElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => {};

  @state() private context: OrganizationContext | null = null;
  @state() private scopes: OrganizationScopeResult[] = [];
  @state() private managementScopes: OrganizationScopeResult[] = [];
  @state() private scopesHasMore = false;
  @state() private selectedScopeId = "";
  @state() private management: OrganizationManagement | null = null;
  @state() private userResults: OrganizationUserSearch["items"] = [];
  @state() private userResultsHasMore = false;
  @state() private managementScopesHasMore = false;
  @state() private loading = true;
  @state() private busy = false;
  @state() private error = "";
  @state() private notice = "";
  @state() private activeTab: "overview" | "management" = "overview";
  @state() private pendingAction: OrganizationPendingAction | null = null;
  private managementEpoch = 0;
  private scopeSearchEpoch = 0;
  private managementSearchEpoch = 0;
  private userSearchEpoch = 0;

  private get api() {
    return new PlatformClawOrganizationApi({
      fetchImpl: this.fetchImpl,
      onUnauthenticated: this.onUnauthenticated,
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.refresh());
  }

  private messageFor(error: unknown): string {
    return organizationErrorMessage(error, this.pendingAction?.kind === "archive");
  }

  private async refresh(): Promise<boolean> {
    this.scopeSearchEpoch += 1;
    this.managementSearchEpoch += 1;
    this.loading = true;
    this.error = "";
    try {
      const [context, result] = await Promise.all([this.api.context(), this.api.scopes()]);
      this.context = context;
      this.scopes = result.items;
      this.managementScopes = result.items;
      this.managementScopesHasMore = result.hasMore;
      this.scopesHasMore = result.hasMore;
      const selectable = this.managementScopes.find(
        (scope) =>
          scope.capabilities.canManageMembers ||
          scope.capabilities.canManageStructure ||
          scope.capabilities.canManageLeaders,
      );
      if (
        !this.selectedScopeId ||
        !this.managementScopes.some((scope) => scope.id === this.selectedScopeId)
      ) {
        this.selectedScopeId = selectable?.id ?? "";
      }
      await this.refreshManagement();
      return true;
    } catch (error) {
      this.error = this.messageFor(error);
      return false;
    } finally {
      this.loading = false;
    }
  }

  private selectedScope(): OrganizationScopeResult | undefined {
    return this.managementScopes.find((scope) => scope.id === this.selectedScopeId);
  }

  private async refreshManagement(): Promise<void> {
    const epoch = ++this.managementEpoch;
    const selected = this.selectedScope();
    this.management = null;
    this.userSearchEpoch += 1;
    this.userResults = [];
    this.userResultsHasMore = false;
    if (!selected?.capabilities.canManageMembers) {
      return;
    }
    const management = await this.api.management(selected.id);
    if (epoch === this.managementEpoch && selected.id === this.selectedScopeId) {
      this.management = management;
    }
  }

  private loadMoreMembers(offset: number): void {
    const selected = this.selectedScope();
    if (!selected?.capabilities.canManageMembers || this.busy) {
      return;
    }
    this.busy = true;
    const epoch = this.managementEpoch;
    void this.api
      .management(selected.id, offset)
      .then((next) => {
        if (epoch === this.managementEpoch && selected.id === this.selectedScopeId) {
          this.management = {
            ...next,
            members: [...(this.management?.members ?? []), ...next.members],
          };
        }
      })
      .catch((error: unknown) => {
        this.error = this.messageFor(error);
      })
      .finally(() => {
        this.busy = false;
      });
  }

  private async runMutation(action: () => Promise<unknown>, successKey: string): Promise<boolean> {
    if (this.busy) {
      return false;
    }
    this.busy = true;
    this.error = "";
    this.notice = "";
    const previous = this.selectedScope();
    try {
      await action();
      this.notice = t(successKey);
      if (!(await this.refresh())) {
        this.error = "";
        this.notice = t("platformClaw.organization.savedReloadFailed");
        return true;
      }
      if (previous && this.pendingAction?.kind !== "archive") {
        await this.searchManagementScopes(previous.name, previous.id);
      }
      return true;
    } catch (error) {
      const message = this.messageFor(error);
      if (
        error instanceof PlatformClawOrganizationApiError &&
        (error.status === 403 || error.status === 409)
      ) {
        await this.refresh().catch(() => undefined);
      }
      this.error = message;
      return false;
    } finally {
      this.busy = false;
    }
  }

  private searchScopes(query: string): void {
    const epoch = ++this.scopeSearchEpoch;
    this.loading = true;
    void this.api
      .scopes(query)
      .then((result) => {
        if (epoch === this.scopeSearchEpoch) {
          this.scopes = result.items;
          this.scopesHasMore = result.hasMore;
          this.error = "";
        }
      })
      .catch((error: unknown) => {
        if (epoch === this.scopeSearchEpoch) {
          this.error = this.messageFor(error);
        }
      })
      .finally(() => {
        if (epoch === this.scopeSearchEpoch) {
          this.loading = false;
        }
      });
  }

  private async searchManagementScopes(query: string, preferredScopeId?: string): Promise<void> {
    const epoch = ++this.managementSearchEpoch;
    await this.api
      .scopes(query)
      .then(async (result) => {
        if (epoch !== this.managementSearchEpoch) {
          return;
        }
        this.managementScopes = result.items;
        this.managementScopesHasMore = result.hasMore;
        const selectable = this.managementScopes.find(
          (scope) =>
            scope.capabilities.canManageMembers ||
            scope.capabilities.canManageStructure ||
            scope.capabilities.canManageLeaders,
        );
        const preferred = result.items.find((scope) => scope.id === preferredScopeId);
        this.selectedScopeId = preferred?.id ?? selectable?.id ?? "";
        await this.refreshManagement();
        this.error = "";
      })
      .catch((error: unknown) => {
        if (epoch === this.managementSearchEpoch) {
          this.error = this.messageFor(error);
        }
      });
  }

  private renameSelected(): void {
    const selected = this.selectedScope();
    if (!selected?.capabilities.canManageStructure) {
      return;
    }
    this.pendingAction = {
      kind: "rename",
      scopeId: selected.id,
      scopeRevision: selected.revision,
      target: lineageLabel(selected),
      currentName: selected.name,
    };
  }

  private archiveSelected(): void {
    const selected = this.selectedScope();
    if (!selected?.capabilities.canManageStructure) {
      return;
    }
    this.pendingAction = {
      kind: "archive",
      scopeId: selected.id,
      scopeRevision: selected.revision,
      target: lineageLabel(selected),
    };
  }

  private async submitPendingAction(input: { reason: string; name?: string }): Promise<void> {
    const action = this.pendingAction;
    if (!action) {
      return;
    }
    const succeeded = await this.runMutation(async () => {
      switch (action.kind) {
        case "add":
          return await this.api.setMembership({
            scopeId: action.scopeId,
            userId: action.userId,
            role: "member",
            expectedRole: null,
            reason: input.reason,
          });
        case "remove": {
          const result = await this.api.removeMembership({
            scopeId: action.scopeId,
            userId: action.userId,
            expectedRole: action.expectedRole,
            reason: input.reason,
          });
          if (!result.removed) {
            throw new PlatformClawOrganizationApiError(
              "membership did not exist",
              409,
              "organization_membership_not_found",
            );
          }
          return result;
        }
        case "role":
          return await this.api.setMembership({
            scopeId: action.scopeId,
            userId: action.userId,
            role: action.role,
            expectedRole: action.expectedRole,
            reason: input.reason,
          });
        case "rename":
          return await this.api.changeScope(action.scopeId, {
            action: "rename",
            expectedRevision: action.scopeRevision,
            name: input.name ?? action.currentName,
            reason: input.reason,
          });
        case "archive":
          return await this.api.changeScope(action.scopeId, {
            action: "archive",
            expectedRevision: action.scopeRevision,
            reason: input.reason,
          });
      }
      return undefined;
    }, "platformClaw.organization.saved");
    if (succeeded) {
      if (action.kind === "rename") {
        await this.searchManagementScopes(input.name ?? action.currentName, action.scopeId);
      }
      this.pendingAction = null;
    } else {
      await this.updateComplete;
      this.querySelector<HTMLElement>(".organization-action-error")?.focus();
    }
  }

  private renderManagement() {
    return renderSettingsSection(
      {
        title: t("platformClaw.organization.management.title"),
        description: t("platformClaw.organization.management.description"),
      },
      html`${renderOrganizationScopePicker({
        scopes: this.managementScopes,
        selectedScopeId: this.selectedScopeId,
        hasMore: this.managementScopesHasMore,
        onSearch: (query) => void this.searchManagementScopes(query),
        onSelect: (scopeId) => {
          this.selectedScopeId = scopeId;
          void this.refreshManagement().catch((error: unknown) => {
            this.error = this.messageFor(error);
          });
        },
      })}${renderOrganizationRoster({
        selected: this.selectedScope(),
        management: this.management,
        actorUserId: this.context?.actor.id ?? "",
        busy: this.busy,
        onRoleChange: (userId, target, role, expectedRole) => {
          const scope = this.selectedScope();
          if (!scope) {
            return false;
          }
          this.pendingAction = {
            kind: "role",
            scopeId: scope.id,
            userId,
            target: `${lineageLabel(scope)} · ${target} · ${t(
              `platformClaw.organization.role.${role}`,
            )}`,
            role,
            expectedRole,
          };
          return false;
        },
        onRemove: (userId, target, expectedRole) => {
          const scope = this.selectedScope();
          if (!scope) {
            return;
          }
          this.pendingAction = {
            kind: "remove",
            scopeId: scope.id,
            userId,
            target: `${lineageLabel(scope)} · ${target}`,
            expectedRole,
          };
        },
        onLoadMore: (offset) => this.loadMoreMembers(offset),
      })}${renderOrganizationAddMember({
        selected: this.selectedScope(),
        users: this.userResults,
        hasMore: this.userResultsHasMore,
        busy: this.busy,
        onSearch: (query) => {
          if (query.length < 2) {
            this.error = t("platformClaw.organization.errors.searchLength");
            return;
          }
          const scopeId = this.selectedScopeId;
          const managementEpoch = this.managementEpoch;
          const searchEpoch = ++this.userSearchEpoch;
          void this.api
            .users(scopeId, query)
            .then((result) => {
              if (
                managementEpoch === this.managementEpoch &&
                searchEpoch === this.userSearchEpoch &&
                scopeId === this.selectedScopeId
              ) {
                this.userResults = result.items;
                this.userResultsHasMore = result.hasMore;
                this.error = "";
              }
            })
            .catch((error: unknown) => {
              if (
                managementEpoch === this.managementEpoch &&
                searchEpoch === this.userSearchEpoch &&
                scopeId === this.selectedScopeId
              ) {
                this.error = this.messageFor(error);
              }
            });
        },
        onAdd: (userId, target) => {
          const scope = this.selectedScope();
          if (!scope) {
            return;
          }
          this.pendingAction = {
            kind: "add",
            scopeId: scope.id,
            userId,
            target: `${lineageLabel(scope)} · ${target}`,
          };
        },
      })}${renderOrganizationStructure({
        scopes: this.managementScopes,
        selected: this.selectedScope(),
        canCreateRoot: this.context?.actor.isAdministrator === true,
        busy: this.busy,
        onCreate: (params) => {
          void this.runMutation(
            () => this.api.createScope(params),
            "platformClaw.organization.saved",
          );
        },
        onRename: () => this.renameSelected(),
        onArchive: () => this.archiveSelected(),
      })}`,
    );
  }

  override render() {
    if (this.loading) {
      return html`<main class="settings-page">
        <p role="status">${t("platformClaw.organization.loading")}</p>
      </main>`;
    }
    return html`<main class="settings-page platformclaw-organization-page">
      ${this.error ? html`<div class="callout danger" role="alert">${this.error}</div>` : nothing}
      ${this.notice ? html`<div class="callout" role="status">${this.notice}</div>` : nothing}
      ${renderHubTabs({
        id: "platformclaw-organization",
        active: this.activeTab,
        tabs: [
          { value: "overview", label: t("platformClaw.organization.tabs.overview") },
          { value: "management", label: t("platformClaw.organization.tabs.management") },
        ],
        ariaLabel: t("platformClaw.organization.tabs.label"),
        panelId: "platformclaw-organization-panel",
        onSelect: (tab) => {
          this.activeTab = tab;
        },
      })}
      <section id="platformclaw-organization-panel">
        ${this.activeTab === "overview"
          ? renderOrganizationOverview({
              context: this.context,
              scopes: this.scopes,
              scopesHasMore: this.scopesHasMore,
              busy: this.busy,
              onPrimaryChange: (scopeId) =>
                void this.runMutation(
                  () => this.api.setPrimary(scopeId || null),
                  "platformClaw.organization.saved",
                ),
              onSearch: (query) => this.searchScopes(query),
            })
          : this.renderManagement()}
      </section>
      ${renderOrganizationActionDialog({
        action: this.pendingAction,
        busy: this.busy,
        error: this.error,
        onCancel: () => {
          this.pendingAction = null;
        },
        onSubmit: (input) => void this.submitPendingAction(input),
      })}
    </main>`;
  }
}

if (!customElements.get("platformclaw-organization-page")) {
  customElements.define("platformclaw-organization-page", PlatformClawOrganizationPage);
}
