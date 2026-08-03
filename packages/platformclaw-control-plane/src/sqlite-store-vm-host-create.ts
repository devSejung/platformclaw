import type { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import {
  ControlPlaneConflictError,
  ControlPlaneStateError,
  type ControlPlaneIdFactory,
} from "./contracts.js";
import type { VmHost } from "./execution-contracts.js";
import {
  normalizeVmTargetAddress,
  serializeVmHostExecutionEnvironment,
  type VmHostExecutionEnvironment,
} from "./execution-validation.js";
import { nextExecutionResourceId } from "./ids.js";
import { executeSync, takeFirstSync } from "./kysely-sync.js";
import { required } from "./sqlite-store-core.js";
import { rowToVmHost } from "./sqlite-store-execution-mappers.js";
import type { ControlPlaneDatabase, VmHostRow } from "./sqlite-store-types.js";

export function createVmHostInTransaction(params: {
  db: DatabaseSync;
  query: Kysely<ControlPlaneDatabase>;
  idFactory: ControlPlaneIdFactory;
  requireAdmin(): void;
  insertAudit(vmHostId: string): void;
  input: {
    actorUserId: string;
    endpointId: string;
    label: string;
    targetAddress: string;
    executionEnvironment?: VmHostExecutionEnvironment;
    createdAt: number;
  };
}): VmHost {
  params.requireAdmin();
  const input = params.input;
  const endpoint = takeFirstSync(
    params.db,
    params.query.selectFrom("safeconnect_endpoints").selectAll().where("id", "=", input.endpointId),
  );
  if (endpoint?.status !== "active") {
    throw new ControlPlaneStateError("VM host requires an active, pinned SafeConnect endpoint");
  }
  const targetAddress = normalizeVmTargetAddress(input.targetAddress);
  const existing = takeFirstSync(
    params.db,
    params.query
      .selectFrom("vm_hosts")
      .select("id")
      .where("endpoint_id", "=", endpoint.id)
      .where("target_address", "=", targetAddress),
  );
  if (existing) {
    throw new ControlPlaneConflictError(
      "vm_host_conflict",
      `VM host already exists for endpoint and target: ${targetAddress}`,
    );
  }
  const row: VmHostRow = {
    id: nextExecutionResourceId(params.idFactory, "vm-host"),
    endpoint_id: endpoint.id,
    label: required(input.label, "vmHost.label"),
    target_address: targetAddress,
    status: "active",
    created_by_user_id: input.actorUserId,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  };
  executeSync(params.db, params.query.insertInto("vm_hosts").values(row));
  const environmentJson = serializeVmHostExecutionEnvironment(input.executionEnvironment);
  if (environmentJson) {
    executeSync(
      params.db,
      params.query.insertInto("vm_host_execution_environments").values({
        vm_host_id: row.id,
        config_json: environmentJson,
        updated_by_user_id: input.actorUserId,
        updated_at: input.createdAt,
      }),
    );
  }
  params.insertAudit(row.id);
  return rowToVmHost({ ...row, execution_environment_json: environmentJson ?? null });
}
