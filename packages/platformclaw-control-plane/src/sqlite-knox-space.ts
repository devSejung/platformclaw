import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import type { PersonalExecutionTarget } from "./execution-contracts.js";
import type { ExecutionTargetSnapshot } from "./execution-handoff-service.js";
import type {
  KnoxSelfSpaceIdentity,
  KnoxSelfSpaceResolution,
  KnoxSpaceBinding,
} from "./knox-space-contracts.js";
import {
  createSyncKysely,
  executeSync,
  runImmediateTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import type { KnoxSpaceAdmissionRow, KnoxSpaceBindingRow } from "./sqlite-schema-knox-space.js";
import { ensureSpaceSchema } from "./sqlite-schema-spaces.js";
import type { SqliteSpaceStore } from "./sqlite-spaces.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type Database = Pick<
  ControlPlaneDatabase,
  "platform_users" | "agent_bindings" | "personal_execution_profiles" | "control_audit_events"
> & {
  knox_space_bindings: KnoxSpaceBindingRow;
  knox_space_admissions: KnoxSpaceAdmissionRow;
};
const query = createSyncKysely<Database>();

function projectBinding(row: KnoxSpaceBindingRow): KnoxSpaceBinding {
  return {
    id: row.id,
    accountId: row.account_id,
    roomId: row.room_id,
    spaceId: row.space_id,
    pageId: row.page_id,
    generation: row.generation,
    state: row.state,
  };
}

/** Revocation is recorded by the existing authority writer, before a later re-grant. */
export function revokeKnoxSpaceAdmissions(
  db: DatabaseSync,
  scope: {
    spaceId?: string;
    userId?: string;
    bindingId?: string;
    sessionKey?: string;
    accountId?: string;
    roomId?: string;
  },
) {
  ensureSpaceSchema(db);
  let update = query
    .updateTable("knox_space_admissions")
    .set({ state: "revoked", abort_pending: 1 })
    .where("state", "=", "pending");
  if (scope.spaceId !== undefined) {
    update = update.where("space_id", "=", scope.spaceId);
  }
  if (scope.userId !== undefined) {
    update = update.where("user_id", "=", scope.userId);
  }
  if (scope.bindingId !== undefined) {
    update = update.where("binding_id", "=", scope.bindingId);
  }
  if (scope.sessionKey !== undefined) {
    update = update.where("session_key", "=", scope.sessionKey);
  }
  if (scope.accountId !== undefined) {
    update = update.where("account_id", "=", scope.accountId);
  }
  if (scope.roomId !== undefined) {
    update = update.where("room_id", "=", scope.roomId);
  }
  executeSync(db, update);
}

export function knoxTargetIdentity(target: PersonalExecutionTarget): string {
  return JSON.stringify({
    agentId: target.agentId,
    userId: target.userId,
    kind: target.kind,
    targetId: target.targetId,
    revision: target.revision,
    ...(target.kind === "assigned_vm"
      ? { allocationId: target.allocationId, credentialRevision: target.credentialRevision }
      : {}),
  });
}

export class SqliteKnoxSpaceStore {
  private ready = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly spaces: SqliteSpaceStore,
  ) {}

  private ensure() {
    if (!this.ready) {
      ensureSpaceSchema(this.db);
      this.ready = true;
    }
  }

  private requireAdmin(userId: string) {
    this.ensure();
    const actor = takeFirstSync(
      this.db,
      query
        .selectFrom("platform_users")
        .select("id")
        .where("id", "=", userId)
        .where("status", "=", "active")
        .where("global_role", "=", "admin"),
    );
    if (!actor) {
      throw new ControlPlaneAuthorizationError("Administrator access required");
    }
  }

  list(actorUserId: string): KnoxSpaceBinding[] {
    this.requireAdmin(actorUserId);
    return executeSync(
      this.db,
      query
        .selectFrom("knox_space_bindings")
        .selectAll()
        .orderBy("account_id")
        .orderBy("room_id")
        .limit(200),
    ).rows.map(projectBinding);
  }

  admissions(actorUserId: string) {
    this.requireAdmin(actorUserId);
    return executeSync(
      this.db,
      query
        .selectFrom("knox_space_admissions")
        .select([
          "id",
          "account_id as accountId",
          "request_id as requestId",
          "room_id as roomId",
          "user_id as userId",
          "space_id as spaceId",
          "state",
          "abort_pending as cancellationPending",
          "created_at as createdAt",
        ])
        .orderBy("created_at", "desc")
        .limit(200),
    ).rows;
  }

  pendingCancellations(actorUserId: string) {
    this.requireAdmin(actorUserId);
    return executeSync(
      this.db,
      query
        .selectFrom("knox_space_admissions")
        .selectAll()
        .where("abort_pending", "=", 1)
        .orderBy("id")
        .limit(200),
    ).rows;
  }

  acknowledgeCancellation(admissionId: string) {
    executeSync(
      this.db,
      query
        .updateTable("knox_space_admissions")
        .set({ abort_pending: 0 })
        .where("id", "=", admissionId)
        .where("state", "=", "revoked"),
    );
  }

  acknowledgeSpaceCancellation(spaceId: string, userId: string) {
    this.ensure();
    executeSync(
      this.db,
      query
        .updateTable("knox_space_admissions")
        .set({ abort_pending: 0 })
        .where("space_id", "=", spaceId)
        .where("user_id", "=", userId)
        .where("state", "=", "revoked"),
    );
  }

  assertRun(
    sessionKey: string | undefined,
    runId: string | undefined,
  ): KnoxSpaceAdmissionRow | undefined {
    if (!runId?.startsWith("knox-my:")) {
      return undefined;
    }
    this.ensure();
    const row = takeFirstSync(
      this.db,
      query
        .selectFrom("knox_space_admissions")
        .selectAll()
        .where("id", "=", runId.slice("knox-my:".length)),
    );
    if (!row || row.session_key !== sessionKey || row.state !== "pending") {
      throw new ControlPlaneAuthorizationError("Knox request is no longer authorized");
    }
    return row;
  }

  assertTargetRun(
    context: { agentId: string; sessionKey?: string; runId?: string },
    target?: ExecutionTargetSnapshot,
  ): KnoxSpaceAdmissionRow | undefined {
    const row = this.assertRun(context.sessionKey, context.runId);
    if (!row) {
      return undefined;
    }
    const route = JSON.parse(row.result_json) as KnoxSelfSpaceResolution;
    if (route.status !== "resolved" || route.agentId !== context.agentId || !row.user_id) {
      throw new ControlPlaneAuthorizationError("Knox request is no longer authorized");
    }
    if (target && knoxTargetIdentity({ ...target, userId: row.user_id }) !== row.target_json) {
      this.revoke(row.id);
      throw new ControlPlaneAuthorizationError("Knox request is no longer authorized");
    }
    return row;
  }

  binding(accountId: string, roomId: string): KnoxSpaceBinding | undefined {
    this.ensure();
    const row = takeFirstSync(
      this.db,
      query
        .selectFrom("knox_space_bindings")
        .selectAll()
        .where("account_id", "=", accountId)
        .where("room_id", "=", roomId),
    );
    return row ? projectBinding(row) : undefined;
  }

  roomState(accountId: string, roomId: string) {
    return takeFirstSync(
      this.db,
      query
        .selectFrom("agent_bindings")
        .select("state")
        .where("kind", "=", "knox-room")
        .where("knox_account_id", "=", accountId)
        .where("room_id", "=", roomId),
    )?.state;
  }

  manage(
    actorUserId: string,
    params: {
      accountId: string;
      roomId: string;
      spaceId?: string;
      pageId?: string;
      expectedGeneration: number;
      action: "connect" | "disconnect";
    },
  ) {
    this.requireAdmin(actorUserId);
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(actorUserId);
      const current = this.binding(params.accountId, params.roomId);
      if ((current?.generation ?? 0) !== params.expectedGeneration) {
        throw new ControlPlaneConflictError(
          "space_changed",
          "Room connection changed; reload before retrying",
        );
      }
      if (params.action === "connect") {
        if (!params.spaceId || !params.pageId) {
          throw new ControlPlaneStateError("Space and page required");
        }
        this.spaces.page(actorUserId, params.spaceId, params.pageId, "owner");
        if (this.roomState(params.accountId, params.roomId) !== "active") {
          throw new ControlPlaneStateError("An active registered Knox room is required");
        }
      } else if (!current) {
        throw new ControlPlaneStateError("Room connection unavailable");
      }
      if (current) {
        revokeKnoxSpaceAdmissions(this.db, { bindingId: current.id });
      }
      const next: KnoxSpaceBindingRow = {
        id: current?.id ?? randomUUID(),
        account_id: params.accountId,
        room_id: params.roomId,
        space_id: params.spaceId ?? current!.spaceId,
        page_id: params.pageId ?? current!.pageId,
        generation: params.expectedGeneration + 1,
        state: params.action === "connect" ? "active" : "disabled",
      };
      executeSync(
        this.db,
        query
          .insertInto("knox_space_bindings")
          .values(next)
          .onConflict((oc) => oc.columns(["account_id", "room_id"]).doUpdateSet(next)),
      );
      executeSync(
        this.db,
        query.insertInto("control_audit_events").values({
          id: randomUUID(),
          actor_user_id: actorUserId,
          event_type: `knox.space.${params.action}`,
          target_type: "knox-space-binding",
          target_id: next.id,
          details_json: JSON.stringify({
            generation: next.generation,
            spaceId: next.space_id,
            pageId: next.page_id,
          }),
          created_at: Date.now(),
        }),
      );
      return projectBinding(next);
    });
  }

  receipt(identity: KnoxSelfSpaceIdentity): KnoxSpaceAdmissionRow | undefined {
    this.ensure();
    return takeFirstSync(
      this.db,
      query
        .selectFrom("knox_space_admissions")
        .selectAll()
        .where("account_id", "=", identity.accountId)
        .where("request_id", "=", identity.requestId),
    );
  }

  resolution(row: KnoxSpaceAdmissionRow, identity: KnoxSelfSpaceIdentity): KnoxSelfSpaceResolution {
    if (
      row.room_id !== identity.conversationId ||
      row.knox_user_id !== identity.knoxUserId ||
      row.fingerprint !== identity.requestFingerprint ||
      (identity.admissionId !== undefined && identity.admissionId !== row.id)
    ) {
      return { status: "request-conflict", admissionId: row.id };
    }
    if (row.state === "revoked") {
      return { status: "request-revoked", admissionId: row.id };
    }
    if (row.state === "finished" || row.state === "failed") {
      return { status: "request-settled", admissionId: row.id };
    }
    return JSON.parse(row.result_json) as KnoxSelfSpaceResolution;
  }

  reserve(
    identity: KnoxSelfSpaceIdentity,
    build: (admissionId: string) => {
      result: KnoxSelfSpaceResolution;
      target?: PersonalExecutionTarget;
    },
  ): KnoxSelfSpaceResolution {
    this.ensure();
    return runImmediateTransaction(this.db, () => {
      const prior = this.receipt(identity);
      if (prior) {
        return this.resolution(prior, identity);
      }
      const id = randomUUID();
      const { result, target } = build(id);
      const route = result.status === "resolved" ? result : undefined;
      const row: KnoxSpaceAdmissionRow = {
        id,
        account_id: identity.accountId,
        request_id: identity.requestId,
        room_id: identity.conversationId,
        knox_user_id: identity.knoxUserId,
        fingerprint: identity.requestFingerprint,
        binding_id: route?.selfInSpace.bindingId ?? null,
        user_id: route?.selfInSpace.userId ?? null,
        space_id: route?.selfInSpace.spaceId ?? null,
        session_key: route?.sessionKey ?? null,
        result_json: JSON.stringify(result),
        target_json: target ? knoxTargetIdentity(target) : null,
        state: route ? "pending" : "denied",
        abort_pending: 0,
        created_at: Date.now(),
      };
      executeSync(this.db, query.insertInto("knox_space_admissions").values(row));
      return result;
    });
  }

  assertCurrentTarget(target: PersonalExecutionTarget) {
    const binding = takeFirstSync(
      this.db,
      query
        .selectFrom("agent_bindings as binding")
        .innerJoin("platform_users as owner", "owner.id", "binding.user_id")
        .leftJoin(
          "personal_execution_profiles as profile",
          "profile.agent_binding_id",
          "binding.id",
        )
        .select([
          "profile.target_revision",
          "profile.active_target",
          "profile.active_allocation_id",
        ])
        .where("binding.agent_id", "=", target.agentId)
        .where("binding.user_id", "=", target.userId)
        .where("binding.kind", "=", "personal")
        .where("binding.state", "=", "active")
        .where("owner.status", "=", "active"),
    );
    if (!binding) {
      throw new ControlPlaneAuthorizationError("Active personal agent required");
    }
    if (
      (binding.target_revision ?? 0) !== target.revision ||
      (binding.active_target ?? "platform_server") !== target.kind ||
      (target.kind === "assigned_vm" && binding.active_allocation_id !== target.allocationId)
    ) {
      throw new ControlPlaneStateError("Execution target changed");
    }
  }

  revoke(admissionId: string) {
    executeSync(
      this.db,
      query
        .updateTable("knox_space_admissions")
        .set({ state: "revoked", abort_pending: 1 })
        .where("id", "=", admissionId)
        .where("state", "=", "pending"),
    );
  }

  settle(identity: KnoxSelfSpaceIdentity): KnoxSelfSpaceResolution {
    if (!identity.admissionId) {
      throw new ControlPlaneStateError("Admission identity required");
    }
    const row = this.receipt(identity);
    if (!row) {
      return { status: "request-conflict", admissionId: identity.admissionId };
    }
    const result = this.resolution(row, identity);
    if (result.status !== "resolved") {
      return result;
    }
    executeSync(
      this.db,
      query
        .updateTable("knox_space_admissions")
        .set({ state: identity.outcome === "finished" ? "finished" : "failed" })
        .where("id", "=", row.id)
        .where("state", "=", "pending"),
    );
    return { status: "request-settled", admissionId: row.id };
  }
}
