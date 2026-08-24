import {
  ControlPlaneAuthorizationError,
  type ManagedScope,
  type OrganizationContextSnapshot,
  type OrganizationJoinRequest,
  type ReviewableOrganizationJoinRequest,
} from "./contracts.js";
import { executeSync, runReadTransaction, takeFirstSync } from "./kysely-sync.js";
import { resolveOrganizationAuthorization } from "./organization-policy.js";
import { rowToMembership, rowToScope } from "./sqlite-store-core.js";
import { SqliteControlPlaneOrganizationStore } from "./sqlite-store-organization.js";

export abstract class SqliteControlPlaneOrganizationJoinReadStore extends SqliteControlPlaneOrganizationStore {
  protected rowToJoinRequest(row: {
    id: string;
    user_id: string;
    scope_id: string;
    reason: string;
    status: "pending" | "approved" | "rejected" | "cancelled";
    created_at: number;
    decided_at: number | null;
    decision_reason?: string | null;
  }): OrganizationJoinRequest {
    return {
      id: row.id,
      userId: row.user_id,
      scopeId: row.scope_id,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
      ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
      ...(row.decision_reason ? { decisionReason: row.decision_reason } : {}),
    };
  }

  async listOwnOrganizationJoinRequests(params: {
    userId: string;
    limit?: number;
    offset?: number;
  }): Promise<OrganizationJoinRequest[]> {
    return (await this.listOwnOrganizationJoinRequestDetails(params)).map((entry) => entry.request);
  }

  async listOwnOrganizationJoinRequestDetails(params: {
    userId: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = Number.isFinite(params.limit)
      ? Math.max(1, Math.min(Math.trunc(params.limit!), 200))
      : 100;
    const offset = Number.isFinite(params.offset)
      ? Math.max(0, Math.min(Math.trunc(params.offset!), 10_000))
      : 0;
    return runReadTransaction(this.db, () => {
      const actor = this.requireUserRow(params.userId);
      if (actor.status !== "active") {
        throw new ControlPlaneAuthorizationError("active user required");
      }
      const requests = executeSync(
        this.db,
        this.query
          .selectFrom("organization_join_requests")
          .leftJoin(
            "organization_join_request_decisions",
            "organization_join_request_decisions.request_id",
            "organization_join_requests.id",
          )
          .selectAll("organization_join_requests")
          .select("organization_join_request_decisions.reason as decision_reason")
          .where("user_id", "=", params.userId)
          .orderBy("created_at", "desc")
          .orderBy("id")
          .limit(limit)
          .offset(offset),
      ).rows;
      return requests.map((row) => {
        const scopeRow = this.requireScopeRow(row.scope_id);
        return {
          request: this.rowToJoinRequest(row),
          scope: rowToScope(scopeRow),
          lineage: this.scopeLineageRows(scopeRow).map(rowToScope).toReversed(),
        };
      });
    });
  }

  async getOrganizationContextSnapshot(params: {
    userId: string;
    requestLimit?: number;
  }): Promise<OrganizationContextSnapshot> {
    const requestLimit = Number.isFinite(params.requestLimit)
      ? Math.max(1, Math.min(Math.trunc(params.requestLimit!), 50))
      : 20;
    return runReadTransaction(this.db, () => {
      const actor = this.rowToUser(this.requireUserRow(params.userId));
      const directMemberships = executeSync(
        this.db,
        this.query
          .selectFrom("managed_scope_memberships")
          .selectAll()
          .where("user_id", "=", params.userId)
          .orderBy("scope_id")
          .limit(201),
      ).rows.map(rowToMembership);
      const primary = takeFirstSync(
        this.db,
        this.query
          .selectFrom("managed_scope_primary_memberships")
          .innerJoin(
            "managed_scopes",
            "managed_scopes.id",
            "managed_scope_primary_memberships.scope_id",
          )
          .selectAll("managed_scopes")
          .where("managed_scope_primary_memberships.user_id", "=", params.userId),
      );
      const requests = executeSync(
        this.db,
        this.query
          .selectFrom("organization_join_requests")
          .leftJoin(
            "organization_join_request_decisions",
            "organization_join_request_decisions.request_id",
            "organization_join_requests.id",
          )
          .selectAll("organization_join_requests")
          .select("organization_join_request_decisions.reason as decision_reason")
          .where("organization_join_requests.user_id", "=", params.userId)
          .orderBy("organization_join_requests.created_at", "desc")
          .orderBy("organization_join_requests.id")
          .limit(requestLimit),
      ).rows.map((row) => this.rowToJoinRequest(row));
      const joinRequestDetails = requests.map((request) => {
        const scopeRow = this.requireScopeRow(request.scopeId);
        return {
          request,
          scope: rowToScope(scopeRow),
          lineage: this.scopeLineageRows(scopeRow).map(rowToScope).toReversed(),
        };
      });
      const effectiveAccess = this.resolveEffectiveOrganizationAccessSnapshot(params.userId);
      const activeDirectAccess = effectiveAccess.filter((access) => access.source === "direct");
      const hasPendingJoinRequest = Boolean(
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("organization_join_requests")
            .select("id")
            .where("user_id", "=", params.userId)
            .where("status", "=", "pending")
            .limit(1),
        ),
      );
      return {
        effectiveAccess: effectiveAccess.slice(0, 200),
        effectiveAccessHasMore: effectiveAccess.length > 200,
        directMemberships: directMemberships.slice(0, 200),
        directMembershipsHasMore: directMemberships.length > 200,
        directScopeLineages: directMemberships.slice(0, 200).map((membership) => ({
          scopeId: membership.scopeId,
          lineage: this.scopeLineageRows(this.requireScopeRow(membership.scopeId))
            .map(rowToScope)
            .toReversed(),
        })),
        primaryScope: primary ? rowToScope(primary) : null,
        primaryScopeLineage: primary
          ? this.scopeLineageRows(primary).map(rowToScope).toReversed()
          : [],
        joinRequestDetails,
        isUnaffiliated: activeDirectAccess.length === 0,
        hasPendingJoinRequest,
        canReviewJoinRequests:
          actor.globalRole === "admin" ||
          activeDirectAccess.some((access) => access.directRole === "leader"),
        canManageOrganization:
          actor.globalRole === "admin" ||
          activeDirectAccess.some((access) => access.directRole === "leader"),
        canViewOrganizationAudit: actor.globalRole === "admin",
      };
    });
  }

  async listReviewableOrganizationJoinRequests(params: {
    actorUserId: string;
    limit?: number;
    offset?: number;
  }): Promise<OrganizationJoinRequest[]> {
    return (await this.listReviewableOrganizationJoinRequestDetails(params)).map(
      (entry) => entry.request,
    );
  }

  async listReviewableOrganizationJoinRequestDetails(params: {
    actorUserId: string;
    limit?: number;
    offset?: number;
  }): Promise<ReviewableOrganizationJoinRequest[]> {
    const limit = Number.isFinite(params.limit)
      ? Math.max(1, Math.min(Math.trunc(params.limit!), 200))
      : 100;
    const offset = Number.isFinite(params.offset)
      ? Math.max(0, Math.min(Math.trunc(params.offset!), 10_000))
      : 0;
    return runReadTransaction(this.db, () => {
      const actor = this.requireUserRow(params.actorUserId);
      if (actor.status !== "active") {
        return [];
      }
      let query = this.reviewableJoinRequestQuery(actor.id);
      if (actor.global_role !== "admin") {
        query = query.where((expression) =>
          expression.or([
            expression("scope_leader.user_id", "is not", null),
            expression("parent_leader.user_id", "is not", null),
            expression("grandparent_leader.user_id", "is not", null),
          ]),
        );
      }
      const requests = executeSync(
        this.db,
        query
          .orderBy("organization_join_requests.created_at", "desc")
          .orderBy("organization_join_requests.id")
          .limit(limit)
          .offset(offset),
      ).rows;
      const scopesById = new Map<string, ManagedScope>();
      for (const row of requests) {
        for (const lineageRow of this.scopeLineageRows(this.requireScopeRow(row.scope_id))) {
          const scope = rowToScope(lineageRow);
          scopesById.set(scope.id, scope);
        }
      }
      const lineageIds = [...scopesById.keys()];
      const memberships =
        lineageIds.length === 0
          ? []
          : executeSync(
              this.db,
              this.query
                .selectFrom("managed_scope_memberships")
                .selectAll()
                .where("user_id", "=", actor.id)
                .where("scope_id", "in", lineageIds),
            ).rows.map(rowToMembership);
      return requests.map((row) => {
        const scope = scopesById.get(row.scope_id);
        if (
          !scope ||
          !resolveOrganizationAuthorization({
            actor: this.rowToUser(actor),
            targetScope: scope,
            scopes: [...scopesById.values()],
            memberships,
          }).canManageMembers
        ) {
          throw new ControlPlaneAuthorizationError("organization request review not allowed");
        }
        return {
          request: this.rowToJoinRequest(row),
          applicant: {
            id: row.user_id,
            accountId: row.applicant_account_id,
            status: row.applicant_status,
            ...(row.applicant_display_name ? { displayName: row.applicant_display_name } : {}),
          },
          scope,
          lineage: this.scopeLineageRows(this.requireScopeRow(scope.id))
            .map(rowToScope)
            .toReversed(),
        };
      });
    });
  }

  private reviewableJoinRequestQuery(actorId: string) {
    return this.query
      .selectFrom("organization_join_requests")
      .innerJoin("platform_users", "platform_users.id", "organization_join_requests.user_id")
      .innerJoin("managed_scopes as scope", "scope.id", "organization_join_requests.scope_id")
      .leftJoin("managed_scopes as parent", "parent.id", "scope.parent_scope_id")
      .leftJoin("managed_scopes as grandparent", "grandparent.id", "parent.parent_scope_id")
      .leftJoin("managed_scope_memberships as scope_leader", (join) =>
        join
          .onRef("scope_leader.scope_id", "=", "scope.id")
          .on("scope_leader.user_id", "=", actorId)
          .on("scope_leader.role", "=", "leader"),
      )
      .leftJoin("managed_scope_memberships as parent_leader", (join) =>
        join
          .onRef("parent_leader.scope_id", "=", "parent.id")
          .on("parent_leader.user_id", "=", actorId)
          .on("parent_leader.role", "=", "leader"),
      )
      .leftJoin("managed_scope_memberships as grandparent_leader", (join) =>
        join
          .onRef("grandparent_leader.scope_id", "=", "grandparent.id")
          .on("grandparent_leader.user_id", "=", actorId)
          .on("grandparent_leader.role", "=", "leader"),
      )
      .selectAll("organization_join_requests")
      .select([
        "platform_users.account_id as applicant_account_id",
        "platform_users.display_name as applicant_display_name",
        "platform_users.status as applicant_status",
      ])
      .where("organization_join_requests.status", "=", "pending")
      .where("organization_join_requests.user_id", "!=", actorId)
      .where("scope.status", "=", "active")
      .where((expression) =>
        expression.or([
          expression.and([
            expression("scope.kind", "=", "team"),
            expression("scope.parent_scope_id", "is", null),
          ]),
          expression.and([
            expression("scope.kind", "=", "group"),
            expression("parent.kind", "=", "team"),
            expression("parent.status", "=", "active"),
          ]),
          expression.and([
            expression("scope.kind", "=", "part"),
            expression("parent.kind", "=", "group"),
            expression("parent.status", "=", "active"),
            expression("grandparent.kind", "=", "team"),
            expression("grandparent.status", "=", "active"),
          ]),
        ]),
      );
  }
}
