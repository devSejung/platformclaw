import type { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import type {
  VmAdministrationAgent,
  VmAdministrationAllocation,
  VmAdministrationSnapshot,
} from "./execution-contracts.js";
import { executeSync } from "./kysely-sync.js";
import { rowToAllocation, rowToEndpoint, rowToVmHost } from "./sqlite-store-execution-mappers.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

export function readVmAdministrationSnapshot(params: {
  db: DatabaseSync;
  query: Kysely<ControlPlaneDatabase>;
  requireAdmin(): void;
}): VmAdministrationSnapshot {
  params.requireAdmin();
  const endpoints = executeSync(
    params.db,
    params.query.selectFrom("safeconnect_endpoints").selectAll().orderBy("label").orderBy("id"),
  ).rows.map(rowToEndpoint);
  const hosts = executeSync(
    params.db,
    params.query
      .selectFrom("vm_hosts")
      .leftJoin(
        "vm_host_execution_environments",
        "vm_host_execution_environments.vm_host_id",
        "vm_hosts.id",
      )
      .selectAll("vm_hosts")
      .select("vm_host_execution_environments.config_json as execution_environment_json")
      .orderBy("vm_hosts.label")
      .orderBy("vm_hosts.id"),
  ).rows.map(rowToVmHost);
  const agents: VmAdministrationAgent[] = executeSync(
    params.db,
    params.query
      .selectFrom("agent_bindings")
      .innerJoin("platform_users", "platform_users.id", "agent_bindings.user_id")
      .leftJoin("vm_allocations", (join) =>
        join
          .onRef("vm_allocations.agent_binding_id", "=", "agent_bindings.id")
          .on("vm_allocations.status", "!=", "revoked"),
      )
      .select([
        "platform_users.id as user_id",
        "platform_users.account_id as account_id",
        "platform_users.display_name as display_name",
        "platform_users.department as department",
        "agent_bindings.agent_id as agent_id",
        "vm_allocations.id as allocation_id",
      ])
      .where("agent_bindings.kind", "=", "personal")
      .where("agent_bindings.state", "=", "active")
      .where("platform_users.status", "=", "active")
      .orderBy("platform_users.account_id"),
  ).rows.map((row) =>
    Object.assign(
      { userId: row.user_id, accountId: row.account_id, agentId: row.agent_id },
      row.display_name ? { displayName: row.display_name } : {},
      row.department ? { department: row.department } : {},
      row.allocation_id ? { allocationId: row.allocation_id } : {},
    ),
  );
  const allocations: VmAdministrationAllocation[] = executeSync(
    params.db,
    params.query
      .selectFrom("vm_allocations")
      .innerJoin("agent_bindings", "agent_bindings.id", "vm_allocations.agent_binding_id")
      .innerJoin("platform_users", "platform_users.id", "agent_bindings.user_id")
      .innerJoin("vm_hosts", "vm_hosts.id", "vm_allocations.vm_host_id")
      .selectAll("vm_allocations")
      .select([
        "agent_bindings.agent_id as agent_id",
        "platform_users.account_id as account_id",
        "platform_users.display_name as display_name",
        "vm_hosts.label as vm_label",
      ])
      .where("vm_allocations.status", "!=", "revoked")
      .orderBy("platform_users.account_id"),
  ).rows.map((row) =>
    Object.assign(
      rowToAllocation(row),
      { agentId: row.agent_id, accountId: row.account_id, vmLabel: row.vm_label },
      row.display_name ? { displayName: row.display_name } : {},
    ),
  );
  return { endpoints, hosts, agents, allocations };
}
