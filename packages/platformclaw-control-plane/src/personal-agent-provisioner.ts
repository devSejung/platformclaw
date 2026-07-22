import path from "node:path";
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import type {
  PersonalAgentProvisioner,
  PersonalAgentProvisioningRequest,
} from "./browser-auth-service.js";
import type { PersonalAgentBinding, PlatformUser } from "./contracts.js";
import type { EmployeeDirectoryProfile } from "./employee-auth-client.js";
import { renderEmployeeProfileArtifact } from "./employee-profile-artifact.js";
import { GatewayAdminRpcError, type GatewayAdminRpc } from "./gateway-admin-rpc-client.js";

type AgentSummary = { id: string; workspace?: string };
type AgentsListResult = { agents?: AgentSummary[] };
type AgentCreateResult = { ok: true; agentId: string; workspace: string };
type ProfileSeedResult = {
  ok: true;
  agentId: string;
  workspace: string;
  created: boolean;
};
type ProfileStatusResult = {
  ok: true;
  agentId: string;
  workspace: string;
  status: "matched" | "missing" | "mismatch";
};

export type PersonalAgentRestartRecoveryResult =
  | { status: "active" }
  | { status: "retry-required"; reason: "profile-missing" }
  | { status: "conflict"; reason: "profile-mismatch" };

export type GatewayPersonalAgentProvisionerOptions = {
  rpc: GatewayAdminRpc;
  workspaceRoot: string;
};

const CONFIG_APPLY_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 2_000, 2_000] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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
    const workspace = this.workspaceForAgent(request.binding.agentId);
    await this.ensureAgent(request.binding.agentId, workspace);
    await this.seedEmployeeProfile(request.binding.agentId, workspace, request.profile);
  }

  async reconcileAfterRestart(params: {
    user: PlatformUser;
    binding: PersonalAgentBinding;
  }): Promise<PersonalAgentRestartRecoveryResult> {
    const workspace = this.workspaceForAgent(params.binding.agentId);
    await this.ensureAgent(params.binding.agentId, workspace);
    const profile = await this.options.rpc.call<ProfileStatusResult>(
      "platformclaw.profile.status",
      {
        agentId: params.binding.agentId,
        workspace,
        employeeId: params.user.employeeId,
      },
    );
    if (
      profile.agentId !== params.binding.agentId ||
      path.resolve(profile.workspace) !== workspace ||
      !["matched", "missing", "mismatch"].includes(profile.status)
    ) {
      throw new Error("Gateway profile status returned an invalid payload");
    }
    if (profile.status === "missing") {
      return { status: "retry-required", reason: "profile-missing" };
    }
    if (profile.status === "mismatch") {
      return { status: "conflict", reason: "profile-mismatch" };
    }
    return { status: "active" };
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

  private async getConfiguredAgent(agentId: string): Promise<AgentSummary | undefined> {
    // agents.list reads the live runtime snapshot. config.get resolves the full operator config
    // and is several seconds slower on Windows while still requiring an applied-hash check.
    const result = await this.options.rpc.call<AgentsListResult>("agents.list", {});
    const agents = result.agents ?? [];
    if (!Array.isArray(agents)) {
      throw new Error("Gateway agents.list returned an invalid agents list");
    }
    return agents.find((agent) => agent.id === agentId);
  }

  private verifyWorkspace(agentId: string, actual: string | undefined, expected: string): void {
    if (!actual || path.resolve(actual) !== expected) {
      throw new Error(`Gateway agent workspace mismatch: ${agentId}`);
    }
  }

  private async ensureAgent(agentId: string, workspace: string): Promise<void> {
    const current = await this.getConfiguredAgent(agentId);
    if (current) {
      this.verifyWorkspace(agentId, current.workspace, workspace);
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
      if (
        !(error instanceof GatewayAdminRpcError) ||
        (error.code !== "INVALID_REQUEST" && error.code !== "UNAVAILABLE")
      ) {
        throw error;
      }
      // Creation timeouts have an ambiguous outcome, while another control process may also
      // win the create race. Adopt only the exact live agent and workspace in either case.
      let existing: AgentSummary | undefined;
      try {
        existing = await this.getConfiguredAgent(agentId);
      } catch (lookupError) {
        if (
          error.code === "INVALID_REQUEST" ||
          !(lookupError instanceof GatewayAdminRpcError) ||
          lookupError.code !== "UNAVAILABLE"
        ) {
          throw lookupError;
        }
      }
      if (!existing) {
        if (error.code === "INVALID_REQUEST") {
          throw error;
        }
      } else {
        this.verifyWorkspace(agentId, existing.workspace, workspace);
        return;
      }
    }
    for (const retryDelayMs of CONFIG_APPLY_RETRY_DELAYS_MS) {
      if (retryDelayMs > 0) {
        await delay(retryDelayMs);
      }
      try {
        const configured = await this.getConfiguredAgent(agentId);
        if (configured) {
          this.verifyWorkspace(agentId, configured.workspace, workspace);
          return;
        }
      } catch (error) {
        if (!(error instanceof GatewayAdminRpcError) || error.code !== "UNAVAILABLE") {
          throw error;
        }
      }
    }
    throw new Error(`Gateway agent configuration did not become active: ${agentId}`);
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
