import type { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import { ControlPlaneConflictError } from "./contracts.js";
import type { PersonalExecutionSettings } from "./execution-contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { required } from "./sqlite-store-core.js";
import { rowToPersonalExecutionSettings } from "./sqlite-store-execution-mappers.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type StoreAccess = {
  db: DatabaseSync;
  query: Kysely<ControlPlaneDatabase>;
};

export function readPersonalExecutionSettings(
  store: StoreAccess,
  agentId: string,
): PersonalExecutionSettings | null {
  const row = takeFirstSync(
    store.db,
    store.query
      .selectFrom("agent_bindings")
      .innerJoin(
        "personal_execution_profiles",
        "personal_execution_profiles.agent_binding_id",
        "agent_bindings.id",
      )
      .leftJoin("vm_allocations", (join) =>
        join
          .onRef("vm_allocations.agent_binding_id", "=", "agent_bindings.id")
          .on("vm_allocations.status", "!=", "revoked"),
      )
      .leftJoin("vm_hosts", "vm_hosts.id", "vm_allocations.vm_host_id")
      .leftJoin("safeconnect_endpoints", "safeconnect_endpoints.id", "vm_hosts.endpoint_id")
      .leftJoin(
        "vm_allocation_claude_code_settings",
        "vm_allocation_claude_code_settings.allocation_id",
        "vm_allocations.id",
      )
      .select([
        "agent_bindings.agent_id as agent_id",
        "agent_bindings.user_id as user_id",
        "personal_execution_profiles.active_target as active_target",
        "personal_execution_profiles.target_revision as target_revision",
        "vm_allocations.id as allocation_id",
        "vm_allocations.vm_host_id as vm_host_id",
        "vm_allocations.status as allocation_status",
        "vm_allocations.linux_account as linux_account",
        "vm_allocations.remote_home_dir as remote_home_dir",
        "vm_allocations.remote_workspace_dir as remote_workspace_dir",
        "vm_allocations.last_connection_check_at as last_connection_check_at",
        "vm_allocations.last_connection_succeeded_at as last_connection_succeeded_at",
        "vm_allocations.failure_code as failure_code",
        "vm_hosts.label as vm_label",
        "safeconnect_endpoints.label as safeconnect_label",
        "vm_allocation_claude_code_settings.executable_path as claude_code_executable_path",
        "vm_allocation_claude_code_settings.reported_version as claude_code_reported_version",
        "vm_allocation_claude_code_settings.validated_at as claude_code_validated_at",
      ])
      .where("agent_bindings.agent_id", "=", agentId)
      .where("agent_bindings.kind", "=", "personal")
      .where("agent_bindings.state", "=", "active"),
  );
  return row ? rowToPersonalExecutionSettings(row) : null;
}

export function setPersonalClaudeCodeInStore(params: {
  store: StoreAccess;
  actorUserId: string;
  agentId: string;
  expectedRevision: number;
  executablePath: string;
  reportedVersion: string;
  validatedAt: number;
  insertAudit: (allocationId: string) => void;
}): void {
  runImmediateTransaction(params.store.db, () => {
    const owner = takeFirstSync(
      params.store.db,
      params.store.query
        .selectFrom("agent_bindings")
        .innerJoin(
          "personal_execution_profiles",
          "personal_execution_profiles.agent_binding_id",
          "agent_bindings.id",
        )
        .innerJoin("vm_allocations", "vm_allocations.agent_binding_id", "agent_bindings.id")
        .select([
          "agent_bindings.id as binding_id",
          "agent_bindings.user_id as user_id",
          "personal_execution_profiles.target_revision as target_revision",
          "vm_allocations.id as allocation_id",
          "vm_allocations.status as allocation_status",
        ])
        .where("agent_bindings.agent_id", "=", params.agentId)
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active")
        .where("vm_allocations.status", "!=", "revoked"),
    );
    if (
      !owner ||
      owner.user_id !== params.actorUserId ||
      owner.target_revision !== params.expectedRevision ||
      owner.allocation_status !== "ready"
    ) {
      throw new ControlPlaneConflictError(
        "execution_target_conflict",
        "execution target changed before Claude Code settings were stored",
      );
    }
    const executablePath = required(params.executablePath, "claudeCode.executablePath");
    const reportedVersion = required(params.reportedVersion, "claudeCode.reportedVersion");
    executeSync(
      params.store.db,
      params.store.query
        .insertInto("vm_allocation_claude_code_settings")
        .values({
          allocation_id: owner.allocation_id,
          executable_path: executablePath,
          reported_version: reportedVersion,
          validated_at: params.validatedAt,
          updated_by_user_id: params.actorUserId,
          updated_at: params.validatedAt,
        })
        .onConflict((conflict) =>
          conflict.column("allocation_id").doUpdateSet({
            executable_path: executablePath,
            reported_version: reportedVersion,
            validated_at: params.validatedAt,
            updated_by_user_id: params.actorUserId,
            updated_at: params.validatedAt,
          }),
        ),
    );
    executeSync(
      params.store.db,
      params.store.query
        .updateTable("personal_execution_profiles")
        .set({ target_revision: owner.target_revision + 1, updated_at: params.validatedAt })
        .where("agent_binding_id", "=", owner.binding_id)
        .where("target_revision", "=", owner.target_revision),
    );
    params.insertAudit(owner.allocation_id);
  });
}
