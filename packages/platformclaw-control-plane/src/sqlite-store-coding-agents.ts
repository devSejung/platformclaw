import type { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import {
  CODING_AGENT_IDS,
  emptyCodingAgentConfiguration,
  parseCodingAgentCheckSnapshot,
  parseCodingAgentConfiguration,
  type CodingAgentCheckSnapshot,
  type CodingAgentConfiguration,
  type PersonalCodingAgentSettings,
} from "@platformclaw/coding-agent-contract";
import { ControlPlaneConflictError } from "./contracts.js";
import type { PersonalExecutionSettings } from "./execution-contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { rowToPersonalExecutionSettings } from "./sqlite-store-execution-mappers.js";
import { SqliteControlPlaneExecutionTargetStore } from "./sqlite-store-execution-target.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type StoreAccess = {
  db: DatabaseSync;
  query: Kysely<ControlPlaneDatabase>;
};

type CodingAgentSettingRow = {
  agent: "claude" | "codex" | "opencode";
  enabled: number;
  executable_path: string;
  environment_json: string | null;
  last_check_json: string | null;
};

function parseStoredJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`stored ${label} is invalid; repair the control-plane database`);
  }
}

function codingAgentSettingsFromRows(
  rows: readonly CodingAgentSettingRow[],
): PersonalCodingAgentSettings[] {
  const byAgent = new Map(rows.map((row) => [row.agent, row]));
  return CODING_AGENT_IDS.map((agent) => {
    const row = byAgent.get(agent);
    if (!row) {
      return { hasSavedConfiguration: false, configuration: emptyCodingAgentConfiguration(agent) };
    }
    const configuration = parseCodingAgentConfiguration({
      agent,
      enabled: row.enabled === 1,
      executablePath: row.executable_path,
      ...(agent === "claude"
        ? {
            environment: row.environment_json
              ? parseStoredJson(row.environment_json, "Claude gateway environment")
              : null,
          }
        : {}),
    });
    return {
      hasSavedConfiguration: true,
      configuration,
      ...(row.last_check_json
        ? {
            lastCheck: parseCodingAgentCheckSnapshot(
              parseStoredJson(row.last_check_json, "coding agent check"),
            ),
          }
        : {}),
    };
  });
}

export function readCodingAgentSettings(
  store: StoreAccess,
  allocationId: string | null,
): PersonalCodingAgentSettings[] {
  if (!allocationId) {
    return CODING_AGENT_IDS.map((agent) => ({
      hasSavedConfiguration: false,
      configuration: emptyCodingAgentConfiguration(agent),
    }));
  }
  return codingAgentSettingsFromRows(
    executeSync(
      store.db,
      store.query
        .selectFrom("vm_allocation_coding_agent_settings")
        .select(["agent", "enabled", "executable_path", "environment_json", "last_check_json"])
        .where("allocation_id", "=", allocationId)
        .orderBy("agent"),
    ).rows,
  );
}

function readPersonalExecutionSettings(
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
      ])
      .where("agent_bindings.agent_id", "=", agentId)
      .where("agent_bindings.kind", "=", "personal")
      .where("agent_bindings.state", "=", "active"),
  );
  return row
    ? rowToPersonalExecutionSettings(row, readCodingAgentSettings(store, row.allocation_id))
    : null;
}

function requireOwnedAllocation(
  params: {
    store: StoreAccess;
    actorUserId: string;
    agentId: string;
    expectedRevision: number;
  },
  requireReady: boolean,
) {
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
    (requireReady && owner.allocation_status !== "ready")
  ) {
    throw new ControlPlaneConflictError(
      "execution_target_conflict",
      "execution target changed before coding agent settings were stored",
    );
  }
  return owner;
}

function environmentJson(configuration: CodingAgentConfiguration): string | null {
  return configuration.agent === "claude" ? JSON.stringify(configuration.environment) : null;
}

function setPersonalCodingAgentInStore(params: {
  store: StoreAccess;
  actorUserId: string;
  agentId: string;
  expectedRevision: number;
  configuration: CodingAgentConfiguration;
  updatedAt: number;
  insertAudit: (allocationId: string) => void;
}): void {
  const configuration = parseCodingAgentConfiguration(params.configuration);
  runImmediateTransaction(params.store.db, () => {
    const owner = requireOwnedAllocation(params, false);
    executeSync(
      params.store.db,
      params.store.query
        .insertInto("vm_allocation_coding_agent_settings")
        .values({
          allocation_id: owner.allocation_id,
          agent: configuration.agent,
          enabled: configuration.enabled ? 1 : 0,
          executable_path: configuration.executablePath,
          environment_json: environmentJson(configuration),
          last_check_json: null,
          updated_by_user_id: params.actorUserId,
          updated_at: params.updatedAt,
        })
        .onConflict((conflict) =>
          conflict.columns(["allocation_id", "agent"]).doUpdateSet({
            enabled: configuration.enabled ? 1 : 0,
            executable_path: configuration.executablePath,
            environment_json: environmentJson(configuration),
            last_check_json: null,
            updated_by_user_id: params.actorUserId,
            updated_at: params.updatedAt,
          }),
        ),
    );
    executeSync(
      params.store.db,
      params.store.query
        .updateTable("personal_execution_profiles")
        .set({ target_revision: owner.target_revision + 1, updated_at: params.updatedAt })
        .where("agent_binding_id", "=", owner.binding_id)
        .where("target_revision", "=", owner.target_revision),
    );
    params.insertAudit(owner.allocation_id);
  });
}

function recordPersonalCodingAgentCheckInStore(params: {
  store: StoreAccess;
  actorUserId: string;
  agentId: string;
  expectedRevision: number;
  configuration: CodingAgentConfiguration;
  result: CodingAgentCheckSnapshot;
  insertAudit: (allocationId: string) => void;
}): void {
  const configuration = parseCodingAgentConfiguration(params.configuration);
  const result = parseCodingAgentCheckSnapshot(params.result);
  if (configuration.agent !== result.agent) {
    throw new Error("coding agent check result does not match its configuration");
  }
  runImmediateTransaction(params.store.db, () => {
    const owner = requireOwnedAllocation(params, true);
    const current = takeFirstSync(
      params.store.db,
      params.store.query
        .selectFrom("vm_allocation_coding_agent_settings")
        .select(["enabled", "executable_path", "environment_json"])
        .where("allocation_id", "=", owner.allocation_id)
        .where("agent", "=", configuration.agent),
    );
    if (
      !current ||
      current.enabled !== (configuration.enabled ? 1 : 0) ||
      current.executable_path !== configuration.executablePath ||
      current.environment_json !== environmentJson(configuration)
    ) {
      throw new ControlPlaneConflictError(
        "execution_target_conflict",
        "save the coding agent settings before recording this check",
      );
    }
    executeSync(
      params.store.db,
      params.store.query
        .updateTable("vm_allocation_coding_agent_settings")
        .set({
          last_check_json: JSON.stringify(result),
          updated_by_user_id: params.actorUserId,
          updated_at: result.checkedAt,
        })
        .where("allocation_id", "=", owner.allocation_id)
        .where("agent", "=", configuration.agent),
    );
    params.insertAudit(owner.allocation_id);
  });
}

export abstract class SqliteControlPlaneCodingAgentStore extends SqliteControlPlaneExecutionTargetStore {
  async getPersonalExecutionSettings(agentId: string): Promise<PersonalExecutionSettings | null> {
    return readPersonalExecutionSettings({ db: this.db, query: this.query }, agentId);
  }

  async setPersonalCodingAgent(params: {
    actorUserId: string;
    agentId: string;
    expectedRevision: number;
    configuration: CodingAgentConfiguration;
    updatedAt: number;
  }): Promise<void> {
    setPersonalCodingAgentInStore({
      store: { db: this.db, query: this.query },
      ...params,
      insertAudit: (allocationId) =>
        this.insertAudit(
          params.actorUserId,
          "coding-agent.settings.updated",
          "vm-allocation",
          allocationId,
          params.updatedAt,
          { agent: params.configuration.agent, enabled: params.configuration.enabled },
        ),
    });
  }

  async recordPersonalCodingAgentCheck(params: {
    actorUserId: string;
    agentId: string;
    expectedRevision: number;
    configuration: CodingAgentConfiguration;
    result: CodingAgentCheckSnapshot;
  }): Promise<void> {
    recordPersonalCodingAgentCheckInStore({
      store: { db: this.db, query: this.query },
      ...params,
      insertAudit: (allocationId) =>
        this.insertAudit(
          params.actorUserId,
          "coding-agent.connection.checked",
          "vm-allocation",
          allocationId,
          params.result.checkedAt,
          { agent: params.configuration.agent },
        ),
    });
  }
}
