import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
  type OrganizationJoinRequest,
  type OrganizationContextSnapshot,
  type ReviewableOrganizationJoinRequest,
} from "./contracts.js";
import { executeSync, runReadTransaction, takeFirstSync } from "./kysely-sync.js";
import { resolveOrganizationAuthorization } from "./organization-policy.js";
import { boundedOrganizationReason as boundedReason } from "./organization-validation.js";
import { required, rowToMembership, rowToScope } from "./sqlite-store-core.js";
import { SqliteControlPlaneOrganizationStore } from "./sqlite-store-organization.js";

export abstract class SqliteControlPlaneOrganizationJoinStore extends SqliteControlPlaneOrganizationStore {
  private rowToJoinRequest(row: {
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

  async submitOrganizationJoinRequest(params: {
    requestId: string;
    userId: string;
    scopeId: string;
    reason: string;
    submittedAt: number;
  }): Promise<OrganizationJoinRequest> {
    return this.runOrganizationMutation(
      {
        actorUserId: params.userId,
        action: "organization.join.request.denied",
        targetType: "managed-scope",
        targetId: params.scopeId,
        createdAt: params.submittedAt,
        scopeId: params.scopeId,
      },
      () => {
        const user = this.requireUserRow(params.userId);
        const scope = this.requireScopeRow(params.scopeId);
        if (user.status !== "active") {
          throw new ControlPlaneStateError("disabled users cannot request organization membership");
        }
        if (
          scope.status !== "active" ||
          this.scopeLineageRows(scope).some((ancestor) => ancestor.status !== "active")
        ) {
          throw new ControlPlaneStateError("organization scope is unavailable");
        }
        if (this.selectMembership(scope.id, user.id)) {
          throw new ControlPlaneStateError("user is already a direct member of this scope");
        }
        const pending = takeFirstSync(
          this.db,
          this.query
            .selectFrom("organization_join_requests")
            .select("id")
            .where("user_id", "=", user.id)
            .where("scope_id", "=", scope.id)
            .where("status", "=", "pending"),
        );
        if (pending) {
          throw new ControlPlaneConflictError(
            "organization_join_request_conflict",
            "an organization join request is already pending for this scope",
          );
        }
        const reason = boundedReason(params.reason, "reason");
        executeSync(
          this.db,
          this.query.insertInto("organization_join_requests").values({
            id: required(params.requestId, "requestId"),
            user_id: user.id,
            scope_id: scope.id,
            reason,
            status: "pending",
            created_at: params.submittedAt,
            decided_at: null,
          }),
        );
        this.insertOrganizationAudit({
          actorUserId: user.id,
          action: "organization.join.requested",
          targetType: "managed-scope",
          targetId: scope.id,
          createdAt: params.submittedAt,
          outcome: "succeeded",
          scopeId: scope.id,
          self: true,
          reason,
          details: { requestId: params.requestId },
        });
        return this.rowToJoinRequest(
          takeFirstSync(
            this.db,
            this.query
              .selectFrom("organization_join_requests")
              .selectAll()
              .where("id", "=", params.requestId),
          )!,
        );
      },
    );
  }

  async decideOrganizationJoinRequest(params: {
    actorUserId: string;
    requestId: string;
    decision: "approved" | "rejected";
    reason: string;
    decidedAt: number;
  }): Promise<OrganizationJoinRequest> {
    return this.runOrganizationMutation(
      {
        actorUserId: params.actorUserId,
        action: `organization.join.${params.decision}.denied`,
        targetType: "organization-join-request",
        targetId: params.requestId,
        createdAt: params.decidedAt,
      },
      () => {
        const actor = this.requireUserRow(params.actorUserId);
        const request = takeFirstSync(
          this.db,
          this.query
            .selectFrom("organization_join_requests")
            .selectAll()
            .where("id", "=", params.requestId),
        );
        if (!request) {
          throw new ControlPlaneNotFoundError("organization-join-request", params.requestId);
        }
        const scope = this.requireScopeRow(request.scope_id);
        const actorIsAdmin = actor.status === "active" && actor.global_role === "admin";
        if (
          !actorIsAdmin &&
          (actor.status !== "active" || !this.isLeaderForScope(actor.id, scope))
        ) {
          // Request identifiers are opaque, but inaccessible rows still behave as absent so
          // callers cannot probe another subtree's request state or applicant.
          throw new ControlPlaneNotFoundError("organization-join-request", params.requestId);
        }
        if (actor.id === request.user_id) {
          throw new ControlPlaneAuthorizationError("users cannot review their own join request");
        }
        if (request.status !== "pending") {
          throw new ControlPlaneConflictError(
            "organization_join_request_terminal_conflict",
            "organization join request already has a terminal decision",
          );
        }
        if (
          scope.status !== "active" ||
          this.scopeLineageRows(scope).some((ancestor) => ancestor.status !== "active")
        ) {
          throw new ControlPlaneStateError("organization scope is unavailable");
        }
        const reason = boundedReason(params.reason, "reason");
        if (params.decision === "approved") {
          const target = this.requireUserRow(request.user_id);
          if (target.status !== "active") {
            throw new ControlPlaneStateError("cannot approve membership for a disabled user");
          }
          executeSync(
            this.db,
            this.query
              .insertInto("managed_scope_memberships")
              .values({
                scope_id: scope.id,
                user_id: target.id,
                role: "member",
                created_at: params.decidedAt,
                updated_at: params.decidedAt,
              })
              .onConflict((conflict) => conflict.columns(["scope_id", "user_id"]).doNothing()),
          );
        }
        executeSync(
          this.db,
          this.query.insertInto("organization_join_request_decisions").values({
            request_id: request.id,
            decision: params.decision,
            actor_user_id: actor.id,
            reason,
            decided_at: params.decidedAt,
          }),
        );
        executeSync(
          this.db,
          this.query
            .updateTable("organization_join_requests")
            .set({ status: params.decision, decided_at: params.decidedAt })
            .where("id", "=", request.id),
        );
        this.insertOrganizationAudit({
          actorUserId: actor.id,
          action: `organization.join.${params.decision}`,
          targetType: "managed-scope",
          targetId: scope.id,
          createdAt: params.decidedAt,
          outcome: "succeeded",
          scopeId: scope.id,
          reason,
          details: { requestId: request.id, userId: request.user_id },
        });
        return this.rowToJoinRequest({
          ...request,
          status: params.decision,
          decided_at: params.decidedAt,
          decision_reason: reason,
        });
      },
    );
  }

  async cancelOrganizationJoinRequest(params: {
    actorUserId: string;
    requestId: string;
    reason: string;
    cancelledAt: number;
  }): Promise<OrganizationJoinRequest> {
    return this.runOrganizationMutation(
      {
        actorUserId: params.actorUserId,
        action: "organization.join.cancel.denied",
        targetType: "organization-join-request",
        targetId: params.requestId,
        createdAt: params.cancelledAt,
      },
      () => {
        const actor = this.requireUserRow(params.actorUserId);
        if (actor.status !== "active") {
          throw new ControlPlaneAuthorizationError("active user required");
        }
        const request = takeFirstSync(
          this.db,
          this.query
            .selectFrom("organization_join_requests")
            .selectAll()
            .where("id", "=", params.requestId),
        );
        if (!request) {
          throw new ControlPlaneNotFoundError("organization-join-request", params.requestId);
        }
        if (request.user_id !== params.actorUserId) {
          throw new ControlPlaneNotFoundError("organization-join-request", params.requestId);
        }
        if (request.status !== "pending") {
          throw new ControlPlaneConflictError(
            "organization_join_request_terminal_conflict",
            "organization join request is no longer pending",
          );
        }
        const reason = boundedReason(params.reason, "reason");
        executeSync(
          this.db,
          this.query.insertInto("organization_join_request_decisions").values({
            request_id: request.id,
            decision: "cancelled",
            actor_user_id: params.actorUserId,
            reason,
            decided_at: params.cancelledAt,
          }),
        );
        executeSync(
          this.db,
          this.query
            .updateTable("organization_join_requests")
            .set({ status: "cancelled", decided_at: params.cancelledAt })
            .where("id", "=", request.id),
        );
        this.insertOrganizationAudit({
          actorUserId: params.actorUserId,
          action: "organization.join.cancelled",
          targetType: "managed-scope",
          targetId: request.scope_id,
          createdAt: params.cancelledAt,
          outcome: "succeeded",
          scopeId: request.scope_id,
          self: true,
          reason,
          details: { requestId: request.id },
        });
        return this.rowToJoinRequest({
          ...request,
          status: "cancelled",
          decided_at: params.cancelledAt,
          decision_reason: reason,
        });
      },
    );
  }

  async listOwnOrganizationJoinRequests(params: {
    userId: string;
    limit?: number;
    offset?: number;
  }): Promise<OrganizationJoinRequest[]> {
    const boundedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.min(Math.trunc(params.limit!), 200))
      : 100;
    const boundedOffset = Number.isFinite(params.offset)
      ? Math.max(0, Math.min(Math.trunc(params.offset!), 10_000))
      : 0;
    return executeSync(
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
        .limit(boundedLimit)
        .offset(boundedOffset),
    ).rows.map((row) => this.rowToJoinRequest(row));
  }

  async getOrganizationContextSnapshot(params: {
    userId: string;
    requestLimit?: number;
  }): Promise<OrganizationContextSnapshot> {
    const requestLimit = Number.isFinite(params.requestLimit)
      ? Math.max(1, Math.min(Math.trunc(params.requestLimit!), 50))
      : 20;
    return runReadTransaction(this.db, () => {
      this.requireUserRow(params.userId);
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
      const effectiveAccess = this.resolveEffectiveOrganizationAccessSnapshot(params.userId);
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
        joinRequests: requests,
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
    const boundedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.min(Math.trunc(params.limit!), 200))
      : 100;
    const boundedOffset = Number.isFinite(params.offset)
      ? Math.max(0, Math.min(Math.trunc(params.offset!), 10_000))
      : 0;
    return runReadTransaction(this.db, () => {
      const actor = this.requireUserRow(params.actorUserId);
      if (actor.status !== "active") {
        return [];
      }
      const scopes = executeSync(
        this.db,
        this.query.selectFrom("managed_scopes").selectAll(),
      ).rows.map(rowToScope);
      const memberships = executeSync(
        this.db,
        this.query
          .selectFrom("managed_scope_memberships")
          .selectAll()
          .where("user_id", "=", actor.id),
      ).rows.map(rowToMembership);
      const normalizedActor = this.rowToUser(actor);
      const reviewableScopeIds = scopes
        .filter(
          (scope) =>
            resolveOrganizationAuthorization({
              actor: normalizedActor,
              targetScope: scope,
              scopes,
              memberships,
            }).canManageMembers,
        )
        .map((scope) => scope.id);
      if (reviewableScopeIds.length === 0) {
        return [];
      }
      const scopesById = new Map(scopes.map((scope) => [scope.id, scope]));
      return executeSync(
        this.db,
        this.query
          .selectFrom("organization_join_requests")
          .innerJoin("platform_users", "platform_users.id", "organization_join_requests.user_id")
          .selectAll("organization_join_requests")
          .select([
            "platform_users.account_id as applicant_account_id",
            "platform_users.display_name as applicant_display_name",
            "platform_users.status as applicant_status",
          ])
          .where("organization_join_requests.status", "=", "pending")
          .where("organization_join_requests.scope_id", "in", reviewableScopeIds)
          .where("organization_join_requests.user_id", "!=", actor.id)
          .orderBy("organization_join_requests.created_at", "desc")
          .orderBy("organization_join_requests.id")
          .limit(boundedLimit)
          .offset(boundedOffset),
      ).rows.map((row) => {
        const scope = scopesById.get(row.scope_id);
        if (!scope) {
          throw new ControlPlaneNotFoundError("managed-scope", row.scope_id);
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
        };
      });
    });
  }
}
