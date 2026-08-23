import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";

export const PLATFORMCLAW_AGENT_CONFIG_STATUS_METHOD = "platformclaw.agent.configStatus";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(respond: GatewayRequestHandlerOptions["respond"], message: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
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
