import { ControlPlaneStateError } from "./contracts.js";
import type { ControlPlaneVmLifecycleStore, VmHost } from "./execution-contracts.js";
import {
  serializeVmHostExecutionEnvironment,
  type VmHostExecutionEnvironment,
} from "./execution-validation.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { rowToVmHost } from "./sqlite-store-execution-mappers.js";
import { SqliteControlPlaneVmSelfServiceStore } from "./sqlite-store-vm-self-service.js";

export abstract class SqliteControlPlaneVmEnvironmentStore
  extends SqliteControlPlaneVmSelfServiceStore
  implements ControlPlaneVmLifecycleStore
{
  async updateVmHostExecutionEnvironment(params: {
    actorUserId: string;
    vmHostId: string;
    executionEnvironment?: VmHostExecutionEnvironment;
    updatedAt: number;
  }): Promise<VmHost> {
    this.ensureVmHostExecutionEnvironmentSchema();
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const host = takeFirstSync(
        this.db,
        this.query.selectFrom("vm_hosts").selectAll().where("id", "=", params.vmHostId),
      );
      if (!host) {
        throw new ControlPlaneStateError(`VM host not found: ${params.vmHostId}`);
      }
      const environmentJson = serializeVmHostExecutionEnvironment(params.executionEnvironment);
      if (environmentJson) {
        executeSync(
          this.db,
          this.query
            .insertInto("vm_host_execution_environments")
            .values({
              vm_host_id: host.id,
              config_json: environmentJson,
              updated_by_user_id: params.actorUserId,
              updated_at: params.updatedAt,
            })
            .onConflict((conflict) =>
              conflict.column("vm_host_id").doUpdateSet({
                config_json: environmentJson,
                updated_by_user_id: params.actorUserId,
                updated_at: params.updatedAt,
              }),
            ),
        );
      } else {
        executeSync(
          this.db,
          this.query.deleteFrom("vm_host_execution_environments").where("vm_host_id", "=", host.id),
        );
      }
      this.insertAudit(
        params.actorUserId,
        "vm.host.execution-environment.updated",
        "vm-host",
        host.id,
        params.updatedAt,
        {
          pathEntries: params.executionEnvironment?.pathPrepend.length ?? 0,
          variableNames: Object.keys(params.executionEnvironment?.variables ?? {}).toSorted(),
        },
      );
      return rowToVmHost({
        ...host,
        execution_environment_json: environmentJson ?? null,
      });
    });
  }
}
