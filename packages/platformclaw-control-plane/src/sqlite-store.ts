import { createHash } from "node:crypto";
import {
  BASEBALL_BATS,
  BASEBALL_DEFAULT_BAT_ID,
  BaseballGameError,
  getBaseballBatDefinition,
  isBaseballBatId,
  type BaseballBatId,
  type BaseballEquipBatResult,
  type BaseballGameErrorCode,
  type BaseballGameStore,
  type BaseballPlateAppearanceOutcome,
  type BaseballPlateAppearanceResult,
  type BaseballProgress,
  type BaseballPurchaseBatResult,
} from "./baseball-contracts.js";
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
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { ensureBaseballGameSchema } from "./sqlite-schema-baseball.js";
import { normalizeAccountId } from "./sqlite-store-core.js";
import { SqliteControlPlaneOrganizationKnowledgeStore } from "./sqlite-store-organization-knowledge.js";

type BaseballOperationEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: BaseballGameErrorCode; message: string } };

type BaseballOperationName = "plate_appearance" | "purchase_bat" | "equip_bat";

function normalizeBaseballRequestId(requestId: string): string {
  const normalized = requestId.trim();
  if (!normalized || normalized.length > 128) {
    throw new Error("baseball requestId must be between 1 and 128 characters");
  }
  return normalized;
}

function baseballPayloadDigest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export class SqliteControlPlaneStore
  extends SqliteControlPlaneOrganizationKnowledgeStore
  implements
    ControlPlaneStore,
    ControlPlaneManagementStore,
    ControlPlaneAuditWriter,
    ControlPlaneExecutionManagementStore,
    BaseballGameStore
{
  private baseballGameSchemaReady = false;

  async loadBaseballProgress(userId: string): Promise<BaseballProgress> {
    this.ensureBaseballGameSchema();
    return runImmediateTransaction(this.db, () => {
      this.ensureBaseballProgress(userId);
      return this.readBaseballProgress(userId);
    });
  }

  async rewardBaseballPlateAppearance(params: {
    userId: string;
    requestId: string;
    outcome: BaseballPlateAppearanceOutcome;
    distanceM?: number;
  }): Promise<BaseballPlateAppearanceResult> {
    const distanceM =
      params.outcome === "home_run" || params.outcome === "hit" ? params.distanceM : undefined;
    return this.runBaseballIdempotentOperation(
      params.userId,
      params.requestId,
      "plate_appearance",
      { outcome: params.outcome, distanceM: distanceM ?? null },
      () => {
        const current = this.ensureBaseballProgress(params.userId);
        const awardedGold = params.outcome === "home_run" ? 1 : 0;
        const bestDistanceM =
          distanceM === undefined
            ? current.best_distance_m
            : Math.max(current.best_distance_m, distanceM);
        const totalHomers = current.total_homers + awardedGold;
        const changed = awardedGold === 1 || bestDistanceM !== current.best_distance_m;
        if (changed) {
          executeSync(
            this.db,
            this.query
              .updateTable("baseball_game_progress")
              .set({
                gold: current.gold + awardedGold,
                total_homers: totalHomers,
                best_distance_m: bestDistanceM,
                revision: current.revision + 1,
              })
              .where("user_id", "=", params.userId),
          );
        }
        return {
          awardedGold: awardedGold as 0 | 1,
          progress: this.readBaseballProgress(params.userId),
        };
      },
    );
  }

  async purchaseBaseballBat(params: {
    userId: string;
    requestId: string;
    batId: BaseballBatId;
  }): Promise<BaseballPurchaseBatResult> {
    return this.runBaseballIdempotentOperation(
      params.userId,
      params.requestId,
      "purchase_bat",
      { batId: params.batId },
      () => {
        const bat = getBaseballBatDefinition(params.batId);
        if (!bat) {
          throw new BaseballGameError("unknown_bat", `unknown baseball bat: ${params.batId}`);
        }
        const current = this.ensureBaseballProgress(params.userId);
        const owned = takeFirstSync(
          this.db,
          this.query
            .selectFrom("baseball_owned_bats")
            .select("bat_id")
            .where("user_id", "=", params.userId)
            .where("bat_id", "=", bat.id),
        );
        if (owned) {
          return {
            batId: bat.id,
            price: bat.price,
            purchased: false,
            progress: this.readBaseballProgress(params.userId),
          };
        }
        if (current.gold < bat.price) {
          throw new BaseballGameError(
            "insufficient_gold",
            `not enough baseball gold for ${bat.id}`,
          );
        }
        executeSync(
          this.db,
          this.query.insertInto("baseball_owned_bats").values({
            user_id: params.userId,
            bat_id: bat.id,
          }),
        );
        executeSync(
          this.db,
          this.query
            .updateTable("baseball_game_progress")
            .set({
              gold: current.gold - bat.price,
              revision: current.revision + 1,
            })
            .where("user_id", "=", params.userId),
        );
        return {
          batId: bat.id,
          price: bat.price,
          purchased: true,
          progress: this.readBaseballProgress(params.userId),
        };
      },
    );
  }

  async equipBaseballBat(params: {
    userId: string;
    requestId: string;
    batId: BaseballBatId;
  }): Promise<BaseballEquipBatResult> {
    return this.runBaseballIdempotentOperation(
      params.userId,
      params.requestId,
      "equip_bat",
      { batId: params.batId },
      () => {
        const bat = getBaseballBatDefinition(params.batId);
        if (!bat) {
          throw new BaseballGameError("unknown_bat", `unknown baseball bat: ${params.batId}`);
        }
        const current = this.ensureBaseballProgress(params.userId);
        const owned = takeFirstSync(
          this.db,
          this.query
            .selectFrom("baseball_owned_bats")
            .select("bat_id")
            .where("user_id", "=", params.userId)
            .where("bat_id", "=", bat.id),
        );
        if (!owned) {
          throw new BaseballGameError("bat_not_owned", `baseball bat is not owned: ${bat.id}`);
        }
        const changed = current.equipped_bat_id !== bat.id;
        if (changed) {
          executeSync(
            this.db,
            this.query
              .updateTable("baseball_game_progress")
              .set({ equipped_bat_id: bat.id, revision: current.revision + 1 })
              .where("user_id", "=", params.userId),
          );
        }
        return {
          batId: bat.id,
          changed,
          progress: this.readBaseballProgress(params.userId),
        };
      },
    );
  }

  private ensureBaseballGameSchema(): void {
    if (this.baseballGameSchemaReady) {
      return;
    }
    ensureBaseballGameSchema(this.db);
    this.baseballGameSchemaReady = true;
  }

  private ensureBaseballProgress(userId: string) {
    this.requireUserRow(userId);
    executeSync(
      this.db,
      this.query
        .insertInto("baseball_owned_bats")
        .values({ user_id: userId, bat_id: BASEBALL_DEFAULT_BAT_ID })
        .onConflict((conflict) => conflict.columns(["user_id", "bat_id"]).doNothing()),
    );
    executeSync(
      this.db,
      this.query
        .insertInto("baseball_game_progress")
        .values({
          user_id: userId,
          gold: 0,
          equipped_bat_id: BASEBALL_DEFAULT_BAT_ID,
          total_homers: 0,
          best_distance_m: 0,
          revision: 0,
        })
        .onConflict((conflict) => conflict.column("user_id").doNothing()),
    );
    return this.requireBaseballProgressRow(userId);
  }

  private requireBaseballProgressRow(userId: string) {
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("baseball_game_progress").selectAll().where("user_id", "=", userId),
    );
    if (!row) {
      throw new ControlPlaneStateError(`baseball progress is missing for user: ${userId}`);
    }
    return row;
  }

  private readBaseballProgress(userId: string): BaseballProgress {
    const row = this.requireBaseballProgressRow(userId);
    if (!isBaseballBatId(row.equipped_bat_id)) {
      throw new ControlPlaneStateError(`baseball equipped bat is invalid: ${row.equipped_bat_id}`);
    }
    const owned = executeSync(
      this.db,
      this.query.selectFrom("baseball_owned_bats").select("bat_id").where("user_id", "=", userId),
    ).rows.map((entry) => entry.bat_id);
    const ownedSet = new Set(owned);
    const ownedBatIds = BASEBALL_BATS.filter((bat) => ownedSet.has(bat.id)).map((bat) => bat.id);
    if (!ownedSet.has(row.equipped_bat_id)) {
      throw new ControlPlaneStateError(
        `baseball equipped bat is not owned: ${row.equipped_bat_id}`,
      );
    }
    return {
      gold: row.gold,
      ownedBatIds,
      equippedBatId: row.equipped_bat_id,
      totalHomers: row.total_homers,
      bestDistanceM: row.best_distance_m,
      revision: row.revision,
    };
  }

  private runBaseballIdempotentOperation<T>(
    userId: string,
    rawRequestId: string,
    operation: BaseballOperationName,
    payload: unknown,
    run: () => T,
  ): T {
    this.ensureBaseballGameSchema();
    const requestId = normalizeBaseballRequestId(rawRequestId);
    const payloadDigest = baseballPayloadDigest(payload);
    const envelope = runImmediateTransaction(this.db, (): BaseballOperationEnvelope<T> => {
      this.ensureBaseballProgress(userId);
      const prior = takeFirstSync(
        this.db,
        this.query
          .selectFrom("baseball_idempotency")
          .selectAll()
          .where("user_id", "=", userId)
          .where("request_id", "=", requestId),
      );
      if (prior) {
        if (prior.operation !== operation || prior.payload_digest !== payloadDigest) {
          throw new BaseballGameError(
            "idempotency_conflict",
            "baseball requestId was already used with a different operation or payload",
          );
        }
        return JSON.parse(prior.result_json) as BaseballOperationEnvelope<T>;
      }

      let next: BaseballOperationEnvelope<T>;
      try {
        next = { ok: true, result: run() };
      } catch (error) {
        if (!(error instanceof BaseballGameError)) {
          throw error;
        }
        next = { ok: false, error: { code: error.code, message: error.message } };
      }
      executeSync(
        this.db,
        this.query.insertInto("baseball_idempotency").values({
          user_id: userId,
          request_id: requestId,
          operation,
          payload_digest: payloadDigest,
          result_json: JSON.stringify(next),
        }),
      );
      return next;
    });
    if (!envelope.ok) {
      throw new BaseballGameError(envelope.error.code, envelope.error.message);
    }
    return envelope.result;
  }

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
