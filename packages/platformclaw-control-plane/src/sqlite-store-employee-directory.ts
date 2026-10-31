import { ControlPlaneStateError } from "./contracts.js";
import { parseDirectoryOrganization } from "./directory-organization.js";
import type {
  EmployeeDirectoryBackfillOutcome,
  EmployeeDirectoryOrganizationSnapshot,
  EmployeeDirectoryUser,
} from "./employee-directory.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { ensureEmployeeDirectorySnapshotSchema } from "./sqlite-schema-employee-directory.js";
import { SqliteControlPlaneStoreCore } from "./sqlite-store-core.js";

export abstract class SqliteEmployeeDirectoryStore extends SqliteControlPlaneStoreCore {
  private employeeDirectorySchemaReady = false;

  private ensureEmployeeDirectorySnapshots(): void {
    if (!this.employeeDirectorySchemaReady) {
      ensureEmployeeDirectorySnapshotSchema(this.db);
      this.employeeDirectorySchemaReady = true;
    }
  }

  async recordEmployeeDirectoryAuthentication(params: {
    userId: string;
    org: unknown;
    isTestAccount: boolean;
    expectedLastLoginAt: number;
    observedAt: number;
  }): Promise<EmployeeDirectoryOrganizationSnapshot | null> {
    const parsed = parseDirectoryOrganization(params.org);
    this.ensureEmployeeDirectorySnapshots();
    return runImmediateTransaction(this.db, () => {
      const user = this.requireUserRow(params.userId);
      if (user.status !== "active" || user.last_login_at !== params.expectedLastLoginAt) {
        return null;
      }
      let decision = params.isTestAccount
        ? "test-account"
        : parsed.status === "eligible"
          ? "eligible"
          : parsed.reason;
      let snapshot: EmployeeDirectoryOrganizationSnapshot | null = null;
      if (!params.isTestAccount && parsed.status === "eligible") {
        const organization = parsed.organization;
        let org: unknown = {
          version: 1,
          source: "aicm",
          team: organization.team,
          group: organization.group,
          part: organization.part,
          updatedAt: new Date(organization.sourceUpdatedAt).toISOString(),
        };
        let orgJson = JSON.stringify(org);
        const previous = takeFirstSync(
          this.db,
          this.query
            .selectFrom("employee_directory_snapshots")
            .selectAll()
            .where("user_id", "=", user.id),
        );
        if (previous && previous.source_updated_at > organization.sourceUpdatedAt) {
          decision = "stale-organization";
        } else if (
          previous &&
          previous.source_updated_at === organization.sourceUpdatedAt &&
          previous.org_json !== orgJson
        ) {
          const previousOrg: unknown = JSON.parse(previous.org_json);
          const parsedPrevious = parseDirectoryOrganization(previousOrg);
          const prior = parsedPrevious.status === "eligible" ? parsedPrevious.organization : null;
          const comparableTeams = prior && (prior.group === null) === (organization.group === null);
          const conflictingGroup =
            prior?.group &&
            organization.group &&
            (prior.group.id !== organization.group.id ||
              prior.group.name !== organization.group.name);
          const conflictingTeam =
            comparableTeams &&
            prior.team !== null &&
            organization.team !== null &&
            prior.team !== organization.team;
          if (
            !prior ||
            prior.part.id !== organization.part.id ||
            prior.part.name !== organization.part.name ||
            conflictingGroup ||
            conflictingTeam
          ) {
            decision = "conflicting-organization";
          } else if (
            (prior.group !== null && organization.group === null) ||
            (comparableTeams && organization.team === null)
          ) {
            // Unknowns retain the stronger fact. A newly known Group instead uses
            // its incoming nullable Team intact; never borrow a standalone Team.
            org = previousOrg;
            orgJson = previous.org_json;
          }
        }
        if (decision === "eligible") {
          const values = {
            org_json: orgJson,
            source_updated_at: organization.sourceUpdatedAt,
            observed_at: Math.max(params.observedAt, previous?.observed_at ?? 0),
          };
          executeSync(
            this.db,
            this.query
              .insertInto("employee_directory_snapshots")
              .values({ user_id: user.id, ...values })
              .onConflict((conflict) => conflict.column("user_id").doUpdateSet(values)),
          );
          snapshot = { org, isTestAccount: false };
        }
      }
      // Only an accepted fact may authorize this authentication's replay. Commit
      // both together, independently of graph sync, so failures stay recoverable.
      const values = {
        authenticated_at: params.expectedLastLoginAt,
        decision,
        observed_at: params.observedAt,
      };
      executeSync(
        this.db,
        this.query
          .insertInto("employee_directory_auth_decisions")
          .values({ user_id: user.id, ...values })
          .onConflict((conflict) => conflict.column("user_id").doUpdateSet(values)),
      );
      executeSync(
        this.db,
        this.query
          .deleteFrom("employee_directory_backfill_attempts")
          .where("user_id", "=", user.id),
      );
      return snapshot;
    });
  }

  async getEmployeeDirectoryAuthDecision(
    userId: string,
    authenticatedAt: number,
  ): Promise<string | null> {
    this.ensureEmployeeDirectorySnapshots();
    return (
      takeFirstSync(
        this.db,
        this.query
          .selectFrom("employee_directory_auth_decisions")
          .select("decision")
          .where("user_id", "=", userId)
          .where("authenticated_at", "=", authenticatedAt),
      )?.decision ?? null
    );
  }

  async getEmployeeDirectoryBackfillAttempt(params: {
    userId: string;
    generation: string;
    lastLoginAt: number;
  }): Promise<EmployeeDirectoryBackfillOutcome | null> {
    this.ensureEmployeeDirectorySnapshots();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("employee_directory_backfill_attempts")
        .select(["status", "reason"])
        .where("user_id", "=", params.userId)
        .where("generation", "=", params.generation)
        .where("last_login_at", "=", params.lastLoginAt),
    );
    return row ? { status: row.status, ...(row.reason ? { reason: row.reason } : {}) } : null;
  }

  async recordEmployeeDirectoryBackfillAttempt(params: {
    userId: string;
    generation: string;
    lastLoginAt: number;
    outcome: EmployeeDirectoryBackfillOutcome;
    attemptedAt: number;
  }): Promise<boolean> {
    this.ensureEmployeeDirectorySnapshots();
    return runImmediateTransaction(this.db, () => {
      const user = this.requireUserRow(params.userId);
      if (user.status !== "active" || user.last_login_at !== params.lastLoginAt) {
        return false;
      }
      const values = {
        generation: params.generation,
        last_login_at: params.lastLoginAt,
        status: params.outcome.status,
        reason: params.outcome.reason ?? null,
        attempted_at: params.attemptedAt,
      };
      executeSync(
        this.db,
        this.query
          .insertInto("employee_directory_backfill_attempts")
          .values({ user_id: user.id, ...values })
          .onConflict((conflict) => conflict.column("user_id").doUpdateSet(values)),
      );
      return true;
    });
  }

  async listDirectoryOrganizationBackfillUsers(params: {
    afterUserId?: string;
    limit: number;
  }): Promise<EmployeeDirectoryUser[]> {
    const limit = Math.max(1, Math.min(Math.trunc(params.limit), 200));
    let query = this.query
      .selectFrom("platform_users")
      .innerJoin("enterprise_identities", "enterprise_identities.user_id", "platform_users.id")
      .innerJoin("browser_sessions", "browser_sessions.user_id", "platform_users.id")
      .select(["platform_users.id", "platform_users.last_login_at"])
      .distinct()
      .where("platform_users.status", "=", "active")
      .where("platform_users.last_login_at", "is not", null)
      .where("enterprise_identities.provider", "in", ["ldap", "saml"])
      .orderBy("platform_users.id")
      .limit(limit);
    if (params.afterUserId) {
      query = query.where("platform_users.id", ">", params.afterUserId);
    }
    return executeSync(this.db, query).rows.map((row) => ({
      id: row.id,
      lastLoginAt: row.last_login_at!,
    }));
  }

  async getEmployeeDirectorySnapshot(
    userId: string,
  ): Promise<EmployeeDirectoryOrganizationSnapshot | null> {
    this.ensureEmployeeDirectorySnapshots();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("employee_directory_snapshots")
        .select("org_json")
        .where("user_id", "=", userId),
    );
    if (!row) {
      return null;
    }
    const org = JSON.parse(row.org_json) as unknown;
    if (parseDirectoryOrganization(org).status !== "eligible") {
      throw new ControlPlaneStateError("saved employee directory snapshot is invalid");
    }
    return { org, isTestAccount: false };
  }
}
