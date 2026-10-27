import type { DatabaseSync } from "node:sqlite";
import { emptyCodingAgentConfigurations } from "@platformclaw/coding-agent-contract";
import type { Kysely } from "kysely";
import { ControlPlaneStateError } from "./contracts.js";
import type {
  AssignedVmConnectionTarget,
  ControlPlaneVmSelfServiceStore,
} from "./execution-contracts.js";
import {
  normalizeLinuxAccount,
  parseVmHostExecutionEnvironmentJson,
} from "./execution-validation.js";
import { takeFirstSync } from "./kysely-sync.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

export function preparePersonalVmCandidateInStore(params: {
  db: DatabaseSync;
  query: Kysely<ControlPlaneDatabase>;
  input: Parameters<ControlPlaneVmSelfServiceStore["preparePersonalVmCandidate"]>[0];
}): AssignedVmConnectionTarget {
  const input = params.input;
  const row = takeFirstSync(
    params.db,
    params.query
      .selectFrom("agent_bindings")
      .innerJoin("platform_users", "platform_users.id", "agent_bindings.user_id")
      .innerJoin(
        "personal_execution_profiles",
        "personal_execution_profiles.agent_binding_id",
        "agent_bindings.id",
      )
      .innerJoin("vm_hosts", (join) =>
        join.on("vm_hosts.id", "=", input.vmHostId).on("vm_hosts.status", "=", "active"),
      )
      .innerJoin("safeconnect_endpoints", (join) =>
        join
          .onRef("safeconnect_endpoints.id", "=", "vm_hosts.endpoint_id")
          .on("safeconnect_endpoints.status", "=", "active"),
      )
      .leftJoin(
        "vm_host_execution_environments",
        "vm_host_execution_environments.vm_host_id",
        "vm_hosts.id",
      )
      .select([
        "agent_bindings.user_id as user_id",
        "platform_users.account_id as account_id",
        "personal_execution_profiles.target_revision as target_revision",
        "vm_hosts.id as vm_host_id",
        "vm_hosts.label as vm_label",
        "vm_hosts.target_address as target_address",
        "safeconnect_endpoints.label as safeconnect_label",
        "safeconnect_endpoints.host as endpoint_host",
        "safeconnect_endpoints.port as endpoint_port",
        "safeconnect_endpoints.ad_domain as ad_domain",
        "safeconnect_endpoints.host_key_algorithm as host_key_algorithm",
        "safeconnect_endpoints.host_key_public_key as host_key_public_key",
        "safeconnect_endpoints.host_key_fingerprint as host_key_fingerprint",
        "vm_host_execution_environments.config_json as execution_environment_json",
      ])
      .where("agent_bindings.agent_id", "=", input.agentId)
      .where("agent_bindings.kind", "=", "personal")
      .where("agent_bindings.state", "=", "active")
      .where("platform_users.status", "=", "active"),
  );
  if (
    !row ||
    row.user_id !== input.actorUserId ||
    !row.host_key_algorithm ||
    !row.host_key_public_key ||
    !row.host_key_fingerprint
  ) {
    throw new ControlPlaneStateError("selected development VM is unavailable");
  }
  const allocationId = `candidate:${row.vm_host_id}`;
  const executionEnvironment = parseVmHostExecutionEnvironmentJson(row.execution_environment_json);
  return {
    kind: "assigned_vm",
    agentId: input.agentId,
    userId: row.user_id,
    targetId: allocationId,
    revision: row.target_revision,
    allocationId,
    allocationStatus: "assigned",
    vmLabel: row.vm_label,
    safeConnectLabel: row.safeconnect_label,
    endpointHost: row.endpoint_host,
    endpointPort: row.endpoint_port,
    adDomain: row.ad_domain,
    adAccount: row.account_id,
    targetAddress: row.target_address,
    linuxAccount: normalizeLinuxAccount(input.linuxAccount),
    hostKeyAlgorithm: row.host_key_algorithm,
    hostKeyPublicKey: row.host_key_public_key,
    hostKeyFingerprint: row.host_key_fingerprint,
    codingAgents: emptyCodingAgentConfigurations(),
    ...(executionEnvironment ? { executionEnvironment } : {}),
  };
}
