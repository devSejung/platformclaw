import {
  parseDirectoryOrganization,
  type DirectoryOrganization,
  type DirectoryOrganizationSyncResult,
} from "./directory-organization.js";
import { executeSync, takeFirstSync } from "./kysely-sync.js";
import { normalizeScopeName } from "./sqlite-store-core.js";
import { SqliteControlPlaneOrganizationMutationStore } from "./sqlite-store-organization-mutation.js";
import type { ManagedScopeRow } from "./sqlite-store-types.js";

type ScopePlan = {
  id: string;
  kind: ManagedScopeRow["kind"];
  key: string;
  name: string;
  parentId: string | null;
  parentKey: string | null;
  existing?: ManagedScopeRow;
};

export abstract class SqliteDirectoryOrganizationStore extends SqliteControlPlaneOrganizationMutationStore {
  async syncDirectoryOrganization(params: {
    userId: string;
    org: unknown;
    isTestAccount: boolean;
    syncedAt: number;
    expectedLastLoginAt?: number;
  }): Promise<DirectoryOrganizationSyncResult> {
    if (params.isTestAccount) {
      return { status: "skipped", reason: "test-account" };
    }
    const parsed = parseDirectoryOrganization(params.org);
    const result =
      parsed.status === "skipped"
        ? parsed
        : this.commitOrganizationMutation(() =>
            this.applyDirectoryOrganization(
              params.userId,
              parsed.organization,
              params.syncedAt,
              params.expectedLastLoginAt,
            ),
          );
    if (
      result.status === "skipped" &&
      result.reason !== "no-organization" &&
      result.reason !== "no-part" &&
      result.reason !== "untrusted-source"
    ) {
      // Directory payloads and exception messages may contain employee data.
      console.warn("platformclaw.organization-sync.skipped", {
        userId: params.userId,
        reason: result.reason,
      });
    }
    return result;
  }

  private selectDirectoryScope(key: string) {
    return takeFirstSync(
      this.db,
      this.query.selectFrom("managed_scopes").selectAll().where("external_key", "=", key),
    );
  }

  private directoryScopePlan(
    kind: ScopePlan["kind"],
    key: string,
    name: string,
    parentId: string | null,
    parentKey: string | null,
    existing = this.selectDirectoryScope(key),
  ): ScopePlan {
    return {
      id: existing?.id ?? this.idFactory.nextManagedScopeId(),
      kind,
      key,
      name,
      parentId,
      parentKey,
      existing,
    };
  }

  private planDirectoryOrganization(org: DirectoryOrganization): ScopePlan[] {
    const partKey = `aicm-part:${org.part.id}`;
    const part = this.selectDirectoryScope(partKey);
    // Claim certainty belongs to this source revision; physical ancestry may
    // retain an older parent. Same-revision unknowns cannot erase an explicit key.
    const unknownParentKey = (scope: ManagedScopeRow | undefined) =>
      org.sourceUpdatedAt > (scope?.directory_updated_at ?? Number.NEGATIVE_INFINITY)
        ? null
        : (scope?.directory_parent_key ?? null);
    const planPart = (parentId: string | null, parentKey: string | null) =>
      this.directoryScopePlan("part", partKey, org.part.name, parentId, parentKey, part);
    if (!org.group) {
      // Unknown preserves an existing parent; a new directory Part has no invented ancestors.
      return [planPart(part?.parent_scope_id ?? null, unknownParentKey(part))];
    }
    const groupKey = `group:${org.group.id}`;
    const group = this.selectDirectoryScope(groupKey);
    if (!org.team && !group) {
      // A known new Group without its Team cannot be linked yet. Record its key
      // on the real Part so cached claims cannot replace the pending assignment.
      return [planPart(null, groupKey)];
    }
    const plans: ScopePlan[] = [];
    let teamId = group?.parent_scope_id ?? null;
    if (org.team) {
      const team = this.directoryScopePlan("team", `team:${org.team}`, org.team, null, null);
      plans.push(team);
      teamId = team.id;
    }
    const groupPlan = this.directoryScopePlan(
      "group",
      groupKey,
      org.group.name,
      teamId,
      org.team ? `team:${org.team}` : unknownParentKey(group),
      group,
    );
    plans.push(groupPlan);
    plans.push(planPart(groupPlan.id, groupKey));
    return plans;
  }

  private applyDirectoryOrganization(
    userId: string,
    org: DirectoryOrganization,
    syncedAt: number,
    expectedLastLoginAt?: number,
  ): DirectoryOrganizationSyncResult {
    const user = this.requireUserRow(userId);
    if (user.status !== "active") {
      return { status: "skipped", reason: "inactive-user" };
    }
    // Recovery reads saved facts before BEGIN. A newer authentication owns the
    // user's current directory decision and must not be overwritten by that read.
    if (expectedLastLoginAt !== undefined && user.last_login_at !== expectedLastLoginAt) {
      return { status: "skipped", reason: "stale-authentication" };
    }
    const previous = takeFirstSync(
      this.db,
      this.query
        .selectFrom("directory_organization_sync")
        .selectAll()
        .where("user_id", "=", userId),
    );
    if (previous && previous.source_updated_at > org.sourceUpdatedAt) {
      return { status: "skipped", reason: "stale-organization" };
    }
    const plans = this.planDirectoryOrganization(org);
    const partPlan = plans.at(-1)!;
    if (
      previous &&
      previous.source_updated_at === org.sourceUpdatedAt &&
      previous.scope_id !== partPlan.id
    ) {
      return { status: "skipped", reason: "conflicting-organization" };
    }
    // Validate every shared node before creating anything. One user's cached
    // login must not roll back another user's newer organization name or parent.
    for (const plan of plans) {
      const current = plan.existing;
      if (!current) {
        continue;
      }
      if (this.scopeLineageRows(current).some((scope) => scope.status !== "active")) {
        return { status: "skipped", reason: "inactive-organization" };
      }
      const changed =
        current.name !== plan.name ||
        current.parent_scope_id !== plan.parentId ||
        current.directory_parent_key !== plan.parentKey;
      // Equal-source names and explicit parents stay immutable. Unknown parent facts
      // may refine while an older physical parent is retained; pending Parts may
      // also materialize their already recorded external Group.
      const refinesUnknownParent =
        current.kind !== "team" &&
        current.name === plan.name &&
        (current.directory_parent_key === null ||
          (current.kind === "part" &&
            current.parent_scope_id === null &&
            current.directory_parent_key === plan.parentKey));
      if (
        changed &&
        current.directory_updated_at !== null &&
        (org.sourceUpdatedAt < current.directory_updated_at ||
          (org.sourceUpdatedAt === current.directory_updated_at && !refinesUnknownParent))
      ) {
        return {
          status: "skipped",
          reason:
            org.sourceUpdatedAt < current.directory_updated_at
              ? "stale-organization"
              : "conflicting-organization",
        };
      }
    }
    let changed = false;
    for (const plan of plans) {
      changed = this.writeDirectoryScope(plan, userId, org.sourceUpdatedAt, syncedAt) || changed;
    }
    // Restore retained manual provenance before dropping the old auto source.
    // Keeping the canonical row preserves roles, primary selection and Wiki grants.
    const oldMemberships = executeSync(
      this.db,
      this.query
        .selectFrom("managed_scope_memberships")
        .selectAll()
        .where("user_id", "=", userId)
        .where("managed_by", "=", "ldap-login")
        .where("scope_id", "!=", partPlan.id),
    ).rows;
    for (const membership of oldMemberships) {
      if (membership.manual_role) {
        executeSync(
          this.db,
          this.query
            .updateTable("managed_scope_memberships")
            .set({
              managed_by: null,
              manual_role: null,
              role: membership.manual_role,
              updated_at: syncedAt,
            })
            .where("scope_id", "=", membership.scope_id)
            .where("user_id", "=", userId),
        );
      } else {
        const primary = takeFirstSync(
          this.db,
          this.query
            .selectFrom("managed_scope_primary_memberships")
            .select("scope_id")
            .where("user_id", "=", userId)
            .where("scope_id", "=", membership.scope_id),
        );
        executeSync(
          this.db,
          this.query
            .deleteFrom("managed_scope_memberships")
            .where("scope_id", "=", membership.scope_id)
            .where("user_id", "=", userId),
        );
        if (primary) {
          this.insertAudit(null, "scope.primary.cleared", "user", userId, syncedAt, {
            source: "ldap-login",
            outcome: "succeeded",
            priorScopeId: membership.scope_id,
          });
        }
      }
      this.directoryAudit(
        membership.manual_role ? "scope.membership.set" : "scope.membership.removed",
        membership.scope_id,
        userId,
        syncedAt,
        { reason: "Directory membership source removed" },
      );
      changed = true;
    }
    const membership = this.selectMembership(partPlan.id, userId);
    if (!membership) {
      executeSync(
        this.db,
        this.query.insertInto("managed_scope_memberships").values({
          scope_id: partPlan.id,
          user_id: userId,
          role: "member",
          managed_by: "ldap-login",
          manual_role: null,
          created_at: syncedAt,
          updated_at: syncedAt,
        }),
      );
      changed = true;
    } else if (!membership.managed_by) {
      executeSync(
        this.db,
        this.query
          .updateTable("managed_scope_memberships")
          .set({ managed_by: "ldap-login", manual_role: membership.role, updated_at: syncedAt })
          .where("scope_id", "=", partPlan.id)
          .where("user_id", "=", userId),
      );
      changed = true;
    }
    this.completeDirectoryJoinRequests(userId, partPlan.id, syncedAt);
    executeSync(
      this.db,
      this.query
        .insertInto("directory_organization_sync")
        .values({ user_id: userId, scope_id: partPlan.id, source_updated_at: org.sourceUpdatedAt })
        .onConflict((conflict) =>
          conflict.column("user_id").doUpdateSet({
            scope_id: partPlan.id,
            source_updated_at: org.sourceUpdatedAt,
          }),
        ),
    );
    if (changed) {
      this.directoryAudit("scope.membership.set", partPlan.id, userId, syncedAt);
    }
    return { status: "synced", scopeId: partPlan.id };
  }

  private writeDirectoryScope(
    plan: ScopePlan,
    userId: string,
    sourceUpdatedAt: number,
    syncedAt: number,
  ) {
    const current = plan.existing;
    const scopeChanged =
      !current || current.name !== plan.name || current.parent_scope_id !== plan.parentId;
    const claimChanged = current && current.directory_parent_key !== plan.parentKey;
    if (!current) {
      executeSync(
        this.db,
        this.query.insertInto("managed_scopes").values({
          id: plan.id,
          kind: plan.kind,
          name: plan.name,
          normalized_name: normalizeScopeName(plan.name),
          parent_scope_id: plan.parentId,
          external_key: plan.key,
          managed_by: "ldap-login",
          directory_updated_at: sourceUpdatedAt,
          directory_parent_key: plan.parentKey,
          status: "active",
          created_by_user_id: userId,
          system_kind: null,
          system_provenance: null,
          created_at: syncedAt,
          updated_at: syncedAt,
        }),
      );
    } else if (
      scopeChanged ||
      claimChanged ||
      sourceUpdatedAt > (current.directory_updated_at ?? 0)
    ) {
      executeSync(
        this.db,
        this.query
          .updateTable("managed_scopes")
          .set({
            name: plan.name,
            normalized_name: normalizeScopeName(plan.name),
            parent_scope_id: plan.parentId,
            directory_parent_key: plan.parentKey,
            directory_updated_at: Math.max(
              sourceUpdatedAt,
              current.directory_updated_at ?? sourceUpdatedAt,
            ),
            updated_at: scopeChanged
              ? Math.max(syncedAt, current.updated_at + 1)
              : current.updated_at,
          })
          .where("id", "=", plan.id),
      );
    }
    if (scopeChanged) {
      const action = !current
        ? "scope.created"
        : current.parent_scope_id !== plan.parentId
          ? "scope.moved"
          : "scope.renamed";
      const change =
        action === "scope.moved"
          ? {
              priorScopeId: current?.parent_scope_id,
              resultScopeId: plan.parentId,
              priorParentKey: current?.directory_parent_key,
              resultParentKey: plan.parentKey,
            }
          : { ...(current ? { beforeName: current.name } : {}), resultName: plan.name };
      this.directoryAudit(action, plan.id, userId, syncedAt, change);
    }
    return scopeChanged;
  }

  private completeDirectoryJoinRequests(userId: string, scopeId: string, at: number): void {
    const requests = executeSync(
      this.db,
      this.query
        .selectFrom("organization_join_requests")
        .selectAll()
        .where("user_id", "=", userId)
        .where("scope_id", "=", scopeId)
        .where("status", "=", "pending"),
    ).rows;
    for (const request of requests) {
      // Directory authority ends the now-satisfied request without inventing a human reviewer.
      executeSync(
        this.db,
        this.query.insertInto("organization_join_request_decisions").values({
          request_id: request.id,
          decision: "cancelled",
          actor_user_id: userId,
          reason: "Membership supplied by ldap-login",
          decided_at: at,
        }),
      );
      executeSync(
        this.db,
        this.query
          .updateTable("organization_join_requests")
          .set({ status: "cancelled", decided_at: at })
          .where("id", "=", request.id),
      );
      this.directoryAudit("organization.join.cancelled", scopeId, userId, at, {
        requestId: request.id,
      });
    }
  }

  private directoryAudit(
    action: string,
    scopeId: string,
    userId: string,
    at: number,
    change = {},
  ): void {
    this.insertAudit(null, action, "managed-scope", scopeId, at, {
      source: "ldap-login",
      outcome: "succeeded",
      userId,
      ...change,
    });
  }
}
