import path from "node:path";
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import { GatewayAdminRpcError, type GatewayAdminRpc } from "./gateway-admin-rpc-client.js";

type AgentSummary = { id: string; workspace?: string };
type AgentsListResult = { agents?: AgentSummary[] };
type AgentCreateResult = { ok: true; agentId: string; workspace: string };

const CONFIG_APPLY_RETRY_DELAYS_MS = [
  0, 250, 500, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 4_000, 4_000,
] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isReadyAgentRuntimeStatus(value: unknown, agentId: string, workspace: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const status = value as Record<string, unknown>;
  return (
    status.ok === true &&
    status.ready === true &&
    status.agentId === agentId &&
    typeof status.workspace === "string" &&
    path.resolve(status.workspace) === workspace
  );
}

/** Registers control-plane-owned agents through the Gateway's serialized config API. */
export class GatewayAgentRegistrar {
  private readonly workspaceRoot: string;

  constructor(
    private readonly rpc: GatewayAdminRpc,
    workspaceRoot: string,
  ) {
    const normalizedRoot = workspaceRoot.trim();
    if (!normalizedRoot) {
      throw new Error("agent workspace root is required");
    }
    this.workspaceRoot = path.resolve(normalizedRoot);
  }

  workspaceForAgent(agentId: string): string {
    if (
      agentId !== agentId.trim() ||
      !isValidAgentId(agentId) ||
      agentId !== agentId.toLowerCase()
    ) {
      throw new Error(`invalid agent id: ${agentId}`);
    }
    const workspace = path.resolve(this.workspaceRoot, agentId);
    if (path.dirname(workspace) !== this.workspaceRoot) {
      throw new Error(`agent workspace escaped root: ${agentId}`);
    }
    return workspace;
  }

  async ensureAgent(agentId: string): Promise<string> {
    const workspace = this.workspaceForAgent(agentId);
    const current = await this.getConfiguredAgentWhenAvailable(agentId);
    if (current) {
      this.verifyWorkspace(agentId, current.workspace, workspace);
      await this.waitForAgentRuntime(agentId, workspace);
      return workspace;
    }
    try {
      const created = await this.rpc.call<AgentCreateResult>("agents.create", {
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
      let existing: AgentSummary | undefined;
      try {
        existing = await this.getConfiguredAgentWhenAvailable(agentId);
      } catch (lookupError) {
        if (
          error.code === "INVALID_REQUEST" ||
          !(lookupError instanceof GatewayAdminRpcError) ||
          lookupError.code !== "UNAVAILABLE"
        ) {
          throw lookupError;
        }
      }
      if (existing) {
        this.verifyWorkspace(agentId, existing.workspace, workspace);
        await this.waitForAgentRuntime(agentId, workspace);
        return workspace;
      }
      if (error.code === "INVALID_REQUEST") {
        throw error;
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
          await this.waitForAgentRuntime(agentId, workspace);
          return workspace;
        }
      } catch (error) {
        if (!(error instanceof GatewayAdminRpcError) || error.code !== "UNAVAILABLE") {
          throw error;
        }
      }
    }
    throw new Error(`Gateway agent configuration did not become active: ${agentId}`);
  }

  private async getConfiguredAgent(agentId: string): Promise<AgentSummary | undefined> {
    const result = await this.rpc.call<AgentsListResult>("agents.list", {});
    const agents = result.agents ?? [];
    if (!Array.isArray(agents)) {
      throw new Error("Gateway agents.list returned an invalid agents list");
    }
    return agents.find((agent) => agent.id === agentId);
  }

  private async getConfiguredAgentWhenAvailable(
    agentId: string,
  ): Promise<AgentSummary | undefined> {
    for (const retryDelayMs of CONFIG_APPLY_RETRY_DELAYS_MS) {
      if (retryDelayMs > 0) {
        await delay(retryDelayMs);
      }
      try {
        return await this.getConfiguredAgent(agentId);
      } catch (error) {
        if (!(error instanceof GatewayAdminRpcError) || error.code !== "UNAVAILABLE") {
          throw error;
        }
      }
    }
    throw new Error("Gateway agent registry did not become available");
  }

  private verifyWorkspace(agentId: string, actual: string | undefined, expected: string): void {
    if (!actual || path.resolve(actual) !== expected) {
      throw new Error(`Gateway agent workspace mismatch: ${agentId}`);
    }
  }

  private async waitForAgentRuntime(agentId: string, workspace: string): Promise<void> {
    for (const retryDelayMs of CONFIG_APPLY_RETRY_DELAYS_MS) {
      if (retryDelayMs > 0) {
        await delay(retryDelayMs);
      }
      try {
        const status = await this.rpc.call<unknown>("platformclaw.agent.runtimeStatus", {
          agentId,
          workspace,
        });
        if (!isReadyAgentRuntimeStatus(status, agentId, workspace)) {
          throw new Error("Gateway agent runtime status returned an invalid payload");
        }
        return;
      } catch (error) {
        if (!(error instanceof GatewayAdminRpcError) || error.code !== "UNAVAILABLE") {
          throw error;
        }
      }
    }
    throw new Error("Gateway agent runtime configuration did not become active");
  }
}
