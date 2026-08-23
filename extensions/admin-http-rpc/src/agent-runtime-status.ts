import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";

export const PLATFORMCLAW_AGENT_RUNTIME_STATUS_METHOD = "platformclaw.agent.runtimeStatus";
export const PLATFORMCLAW_AGENT_CONFIG_STATUS_METHOD = "platformclaw.agent.configStatus";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(respond: GatewayRequestHandlerOptions["respond"], message: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function runtimeUnavailable(
  respond: GatewayRequestHandlerOptions["respond"],
  agentId: string,
): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, `agent runtime is not ready: ${agentId}`),
  );
}

function configuredWorkspace(
  context: GatewayRequestHandlerOptions["context"],
  agentId: string,
  expectedWorkspace: string,
): string | undefined {
  const config = context.getRuntimeConfig();
  if (!listAgentIds(config).includes(agentId)) {
    return undefined;
  }
  const workspace = path.resolve(resolveAgentWorkspaceDir(config, agentId));
  return workspace === expectedWorkspace ? workspace : undefined;
}

function readAgentWorkspaceParams(
  params: unknown,
): { agentId: string; workspace: string } | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  const workspace =
    typeof params.workspace === "string" && path.isAbsolute(params.workspace)
      ? path.resolve(params.workspace)
      : undefined;
  return agentId && workspace ? { agentId, workspace } : undefined;
}

export function handleAgentConfigStatus({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): void {
  const requested = readAgentWorkspaceParams(params);
  if (!requested) {
    invalidRequest(respond, "agent config status params must include an agent and workspace");
    return;
  }
  const config = context.getRuntimeConfig();
  if (!listAgentIds(config).includes(requested.agentId)) {
    respond(true, { ok: true, configured: false, agentId: requested.agentId }, undefined);
    return;
  }
  const workspace = path.resolve(resolveAgentWorkspaceDir(config, requested.agentId));
  respond(
    true,
    {
      ok: true,
      configured: true,
      agentId: requested.agentId,
      workspace,
      matches: workspace === requested.workspace,
    },
    undefined,
  );
}

export async function handleAgentRuntimeStatus({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): Promise<void> {
  const requested = readAgentWorkspaceParams(params);
  if (!requested || !configuredWorkspace(context, requested.agentId, requested.workspace)) {
    invalidRequest(respond, `agent or workspace mismatch: ${requested?.agentId || "unknown"}`);
    return;
  }
  const { agentId, workspace } = requested;

  try {
    // Read the lifecycle-owned generation only. Starting provider discovery here can block every
    // login behind unrelated provider hooks; first-turn admission owns any required materialization.
    const catalog = await context.readPreparedGatewayModelCatalog?.({
      agentId,
      workspaceDir: workspace,
    });
    if (!catalog || !configuredWorkspace(context, agentId, workspace)) {
      // Configuration can become visible before its prepared owner is published.
      // Keep this state retryable so provisioning does not expose a half-ready agent.
      runtimeUnavailable(respond, agentId);
      return;
    }
  } catch {
    runtimeUnavailable(respond, agentId);
    return;
  }

  respond(true, { ok: true, ready: true, agentId, workspace }, undefined);
}
