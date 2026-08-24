import {
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
  type ControlAuditEvent,
  type ControlPlaneAuditWriter,
  type ControlPlaneManagementStore,
  type ControlPlaneStore,
  type PlatformUser,
  type PlatformUserGlobalRole,
  type PlatformUserStatus,
} from "./contracts.js";
import type { ControlPlaneExecutionManagementStore } from "./execution-contracts.js";
import { executeSync, runImmediateTransaction } from "./kysely-sync.js";
import { normalizeAccountId } from "./sqlite-store-core.js";
import { SqliteControlPlaneOrganizationStore } from "./sqlite-store-organization.js";

export class SqliteControlPlaneStore
  extends SqliteControlPlaneOrganizationStore
  implements
    ControlPlaneStore,
    ControlPlaneManagementStore,
    ControlPlaneAuditWriter,
    ControlPlaneExecutionManagementStore
{
  async addDeploymentAdministrator(params: {
    accountId: string;
    changedAt: number;
  }): Promise<{ user: PlatformUser; changed: boolean }> {
    return runImmediateTransaction(this.db, () => {
      const accountId = normalizeAccountId(params.accountId);
      const target = this.selectUserByAccountId(accountId);
      if (!target) {
        throw new ControlPlaneNotFoundError("user", accountId);
      }
      if (target.status !== "active") {
        throw new ControlPlaneStateError(`cannot promote a disabled user: ${accountId}`);
      }
      if (target.global_role === "admin") {
        return { user: this.rowToUser(target), changed: false };
      }
      executeSync(
        this.db,
        this.query
          .updateTable("platform_users")
          .set({ global_role: "admin", updated_at: params.changedAt })
          .where("id", "=", target.id),
      );
      // The service account already owns the control DB. Keep this narrow
      // maintenance path auditable without pretending a browser user acted.
      this.insertAudit(null, "user.role.changed", "user", target.id, params.changedAt, {
        from: target.global_role,
        to: "admin",
        source: "deployment-operator",
      });
      return { user: this.requireUser(target.id), changed: true };
    });
  }

  async setUserGlobalRole(params: {
    actorUserId: string;
    targetUserId: string;
    role: PlatformUserGlobalRole;
    changedAt: number;
  }): Promise<PlatformUser> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const target = this.requireUserRow(params.targetUserId);
      if (params.actorUserId === params.targetUserId && target.global_role !== params.role) {
        throw new ControlPlaneStateError("admins cannot change their own global role");
      }
      if (target.global_role === params.role) {
        return this.rowToUser(target);
      }
      if (target.global_role === "admin" && params.role === "member") {
        const admins = executeSync(
          this.db,
          this.query.selectFrom("platform_users").select("id").where("global_role", "=", "admin"),
        ).rows.length;
        if (admins <= 1) {
          throw new ControlPlaneStateError("cannot demote the last admin");
        }
      }
      executeSync(
        this.db,
        this.query
          .updateTable("platform_users")
          .set({ global_role: params.role, updated_at: params.changedAt })
          .where("id", "=", target.id),
      );
      this.insertAudit(
        params.actorUserId,
        "user.role.changed",
        "user",
        target.id,
        params.changedAt,
        {
          from: target.global_role,
          to: params.role,
        },
      );
      return this.requireUser(target.id);
    });
  }

  async setManagedUserStatus(params: {
    actorUserId: string;
    targetUserId: string;
    status: PlatformUserStatus;
    changedAt: number;
  }): Promise<PlatformUser> {
    let revokedAgentId: string | undefined;
    const user = runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const target = this.requireUserRow(params.targetUserId);
      if (params.actorUserId === params.targetUserId && target.status !== params.status) {
        throw new ControlPlaneStateError("administrators cannot change their own status");
      }
      if (target.status === params.status) {
        return this.rowToUser(target);
      }
      if (target.global_role === "admin" && params.status === "disabled") {
        const activeAdmins = executeSync(
          this.db,
          this.query
            .selectFrom("platform_users")
            .select("id")
            .where("global_role", "=", "admin")
            .where("status", "=", "active"),
        ).rows.length;
        if (activeAdmins <= 1) {
          throw new ControlPlaneStateError("cannot disable the last active administrator");
        }
      }
      executeSync(
        this.db,
        this.query
          .updateTable("platform_users")
          .set({ status: params.status, updated_at: params.changedAt })
          .where("id", "=", target.id),
      );
      if (params.status === "disabled") {
        revokedAgentId = executeSync(
          this.db,
          this.query
            .selectFrom("agent_bindings")
            .select("agent_id")
            .where("user_id", "=", target.id)
            .where("kind", "=", "personal"),
        ).rows[0]?.agent_id;
        executeSync(
          this.db,
          this.query
            .updateTable("browser_sessions")
            .set({ revoked_at: params.changedAt })
            .where("user_id", "=", target.id)
            .where("revoked_at", "is", null),
        );
        executeSync(
          this.db,
          this.query.deleteFrom("encrypted_user_mcp_credentials").where("user_id", "=", target.id),
        );
        executeSync(
          this.db,
          this.query.deleteFrom("encrypted_user_exec_credentials").where("user_id", "=", target.id),
        );
      }
      this.insertAudit(
        params.actorUserId,
        "user.status.changed",
        "user",
        target.id,
        params.changedAt,
        { from: target.status, to: params.status },
      );
      return this.requireUser(target.id);
    });
    if (revokedAgentId && this.onAgentCredentialsRevoked) {
      await this.onAgentCredentialsRevoked(revokedAgentId);
    }
    return user;
  }

  async listAuditEvents(limit = 100): Promise<ControlAuditEvent[]> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.trunc(limit), 500))
      : 100;
    return executeSync(
      this.db,
      this.query
        .selectFrom("control_audit_events")
        .selectAll()
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(boundedLimit),
    ).rows.map((row) => {
      const event: ControlAuditEvent = {
        id: row.id,
        eventType: row.event_type,
        targetType: row.target_type,
        targetId: row.target_id,
        createdAt: row.created_at,
      };
      if (row.actor_user_id) {
        event.actorUserId = row.actor_user_id;
      }
      if (row.details_json) {
        event.details = JSON.parse(row.details_json) as Record<string, unknown>;
      }
      return event;
    });
  }
}
