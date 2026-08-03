import { ControlPlaneStateError } from "./contracts.js";
import type { ExecutionTarget, PersonalExecutionTarget } from "./execution-contracts.js";
import { takeFirstSync } from "./kysely-sync.js";
import { SqliteControlPlaneVmEnvironmentStore } from "./sqlite-store-vm-environment.js";

export abstract class SqliteControlPlaneExecutionTargetStore extends SqliteControlPlaneVmEnvironmentStore {
  abstract resolvePersonalExecutionTarget(agentId: string): Promise<PersonalExecutionTarget>;

  async resolveExecutionTarget(agentId: string): Promise<ExecutionTarget> {
    const normalizedAgentId = agentId.trim();
    const room = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .select(["agent_id", "state"])
        .where("agent_id", "=", normalizedAgentId)
        .where("kind", "=", "knox-room"),
    );
    if (!room) {
      return await this.resolvePersonalExecutionTarget(normalizedAgentId);
    }
    if (room.state !== "active") {
      throw new ControlPlaneStateError("active Knox room execution target is unavailable");
    }
    // Room agents never receive personal VM credentials. Their only execution
    // target is the deployment's Docker-backed platform server sandbox.
    return {
      kind: "platform_server",
      agentId: room.agent_id,
      targetId: "platform-server",
      revision: 0,
    };
  }
}
