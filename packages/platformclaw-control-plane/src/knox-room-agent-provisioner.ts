import type { KnoxRoomAgentBinding } from "./contracts.js";
import { GatewayAgentRegistrar } from "./gateway-agent-registrar.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type { KnoxRoomAgentProvisioner } from "./knox-routing-service.js";

export class GatewayKnoxRoomAgentProvisioner implements KnoxRoomAgentProvisioner {
  private readonly registrar: GatewayAgentRegistrar;

  constructor(options: { rpc: GatewayAdminRpc; workspaceRoot: string }) {
    this.registrar = new GatewayAgentRegistrar(options.rpc, options.workspaceRoot);
  }

  async provision(binding: KnoxRoomAgentBinding): Promise<void> {
    await this.registrar.ensureAgent(binding.agentId);
  }
}
