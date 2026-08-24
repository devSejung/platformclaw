import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
  type OrganizationAuthorization,
} from "./contracts.js";
import { runImmediateTransaction } from "./kysely-sync.js";
import { SqliteControlPlaneOrganizationAccessStore } from "./sqlite-store-organization-access.js";

type OrganizationAuditAuthorizationFacts =
  | OrganizationAuthorization["facts"]
  | { source: "self"; scopeIds: string[] };

export abstract class SqliteControlPlaneOrganizationMutationStore extends SqliteControlPlaneOrganizationAccessStore {
  private organizationAuthorizationFacts(
    actorUserId: string,
    scopeId?: string,
    self = false,
  ): OrganizationAuditAuthorizationFacts {
    const actor = this.selectUserById(actorUserId);
    if (!actor || actor.status !== "active") {
      return { source: "none", scopeIds: [] };
    }
    if (self) {
      return { source: "self", scopeIds: scopeId ? [scopeId] : [] };
    }
    if (!scopeId) {
      return actor.global_role === "admin"
        ? { source: "administrator", scopeIds: [] }
        : { source: "none", scopeIds: [] };
    }
    return this.resolveOrganizationAuthorizationSnapshot(actorUserId, scopeId).facts;
  }

  protected insertOrganizationAudit(params: {
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    createdAt: number;
    outcome: "succeeded" | "denied";
    scopeId?: string;
    self?: boolean;
    authorization?: OrganizationAuditAuthorizationFacts;
    reason?: string;
    details?: Record<string, unknown>;
  }): void {
    this.insertAudit(
      this.selectUserById(params.actorUserId) ? params.actorUserId : null,
      params.action,
      params.targetType,
      params.targetId,
      params.createdAt,
      {
        action: params.action,
        target: { type: params.targetType, id: params.targetId },
        outcome: params.outcome,
        authorization:
          params.authorization ??
          this.organizationAuthorizationFacts(params.actorUserId, params.scopeId, params.self),
        ...(params.reason ? { reason: params.reason } : {}),
        ...params.details,
      },
    );
  }

  protected runOrganizationMutation<T>(
    audit: {
      actorUserId: string;
      action: string;
      targetType: string;
      targetId: string;
      createdAt: number;
      scopeId?: string;
    },
    operation: () => T,
  ): T {
    try {
      return runImmediateTransaction(this.db, operation);
    } catch (error) {
      if (
        error instanceof ControlPlaneAuthorizationError ||
        error instanceof ControlPlaneStateError ||
        error instanceof ControlPlaneConflictError
      ) {
        runImmediateTransaction(this.db, () =>
          this.insertOrganizationAudit({
            ...audit,
            outcome: "denied",
            details: { denialReason: error.message },
          }),
        );
      }
      throw error;
    }
  }
}
