import path from "node:path";
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import type {
  PersonalAgentProvisioner,
  PersonalAgentProvisioningRequest,
} from "./browser-auth-service.js";
import type { EmployeeDirectoryProfile } from "./employee-auth-client.js";
import { renderEmployeeProfileArtifact } from "./employee-profile-artifact.js";
import { GatewayAdminRpcError, type GatewayAdminRpc } from "./gateway-admin-rpc-client.js";

type AgentSummary = { id: string; workspace?: string };
type AgentsListResult = { agents: AgentSummary[] };
type AgentCreateResult = { ok: true; agentId: string; workspace: string };
type ProfileSeedResult = {
  ok: true;
  agentId: string;
  workspace: string;
  created: boolean;
};

export type GatewayPersonalAgentProvisionerOptions = {
  rpc: GatewayAdminRpc;
  workspaceRoot: string;
};

export class GatewayPersonalAgentProvisioner implements PersonalAgentProvisioner {
  private readonly workspaceRoot: string;

  constructor(private readonly options: GatewayPersonalAgentProvisionerOptions) {
    const workspaceRoot = options.workspaceRoot.trim();
    if (!workspaceRoot) {
      throw new Error("personal agent workspace root is required");
    }
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async provisionOrRefresh(request: PersonalAgentProvisioningRequest): Promise<void> {
    if (request.binding.state === "active") {
      return;
    }
    const workspace = this.workspaceForAgent(request.binding.agentId);
    await this.ensureAgent(request.binding.agentId, workspace);
    await this.seedEmployeeProfile(request.binding.agentId, workspace, request.profile);
  }

  private workspaceForAgent(agentId: string): string {
    if (
      agentId !== agentId.trim() ||
      !isValidAgentId(agentId) ||
      agentId !== agentId.toLowerCase()
    ) {
      throw new Error(`invalid personal agent id: ${agentId}`);
    }
    const workspace = path.resolve(this.workspaceRoot, agentId);
    if (path.dirname(workspace) !== this.workspaceRoot) {
      throw new Error(`personal agent workspace escaped root: ${agentId}`);
    }
    return workspace;
  }

  private async listAgent(agentId: string): Promise<AgentSummary | undefined> {
    const result = await this.options.rpc.call<AgentsListResult>("agents.list", {});
    if (!Array.isArray(result.agents)) {
      throw new Error("Gateway agents.list returned an invalid payload");
    }
    return result.agents.find((agent) => agent.id === agentId);
  }

  private verifyWorkspace(agentId: string, actual: string | undefined, expected: string): void {
    if (!actual || path.resolve(actual) !== expected) {
      throw new Error(`Gateway agent workspace mismatch: ${agentId}`);
    }
  }

  private async ensureAgent(agentId: string, workspace: string): Promise<void> {
    const existing = await this.listAgent(agentId);
    if (existing) {
      this.verifyWorkspace(agentId, existing.workspace, workspace);
      return;
    }
    try {
      const created = await this.options.rpc.call<AgentCreateResult>("agents.create", {
        name: agentId,
        workspace,
      });
      if (created.agentId !== agentId) {
        throw new Error(`Gateway created unexpected agent id: ${created.agentId}`);
      }
      this.verifyWorkspace(agentId, created.workspace, workspace);
    } catch (error) {
      if (!(error instanceof GatewayAdminRpcError) || error.code !== "INVALID_REQUEST") {
        throw error;
      }
      // Another control process may win agents.create after this process lists agents.
      const raced = await this.listAgent(agentId);
      if (!raced) {
        throw error;
      }
      this.verifyWorkspace(agentId, raced.workspace, workspace);
    }
  }

  private async seedEmployeeProfile(
    agentId: string,
    workspace: string,
    profile: EmployeeDirectoryProfile,
  ): Promise<void> {
    const seeded = await this.options.rpc.call<ProfileSeedResult>("platformclaw.profile.seed", {
      agentId,
      workspace,
      content: renderEmployeeProfileArtifact(profile),
    });
    this.verifyWorkspace(agentId, seeded.workspace, workspace);
    if (seeded.agentId !== agentId) {
      throw new Error(`Gateway seeded an unexpected agent profile: ${seeded.agentId}`);
    }
  }
}
