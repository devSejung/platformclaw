import path from "node:path";
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import type {
  PersonalAgentProvisioner,
  PersonalAgentProvisioningRequest,
} from "./browser-auth-service.js";
import type { PersonalAgentBinding, PlatformUser } from "./contracts.js";
import type { EmployeeDirectoryProfile } from "./employee-auth-client.js";
import { renderEmployeeProfileArtifact } from "./employee-profile-artifact.js";
import { GatewayAgentRegistrar } from "./gateway-agent-registrar.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";

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

export class GatewayPersonalAgentProvisioner implements PersonalAgentProvisioner {
  private readonly registrar: GatewayAgentRegistrar;

  constructor(private readonly options: GatewayPersonalAgentProvisionerOptions) {
    if (!options.workspaceRoot.trim()) {
      throw new Error("personal agent workspace root is required");
    }
    this.registrar = new GatewayAgentRegistrar(options.rpc, options.workspaceRoot);
  }

  async provisionOrRefresh(request: PersonalAgentProvisioningRequest): Promise<void> {
    this.requirePersonalAgentId(request.binding.agentId);
    const workspace = await this.registrar.ensureAgent(request.binding.agentId);
    await this.seedEmployeeProfile(request.binding.agentId, workspace, request.profile);
  }

  async reconcileAfterRestart(params: {
    user: PlatformUser;
    binding: PersonalAgentBinding;
  }): Promise<PersonalAgentRestartRecoveryResult> {
    this.requirePersonalAgentId(params.binding.agentId);
    const workspace = await this.registrar.ensureAgent(params.binding.agentId);
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

  private requirePersonalAgentId(agentId: string): void {
    if (agentId !== agentId.trim() || !isValidAgentId(agentId) || agentId !== agentId.toLowerCase()) {
      throw new Error(`invalid personal agent id: ${agentId}`);
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
    if (!seeded.workspace || path.resolve(seeded.workspace) !== workspace) {
      throw new Error(`Gateway agent workspace mismatch: ${agentId}`);
    }
    if (seeded.agentId !== agentId) {
      throw new Error(`Gateway seeded an unexpected agent profile: ${seeded.agentId}`);
    }
  }
}
