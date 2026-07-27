import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";

export const PLATFORMCLAW_AGENT_RUNTIME_STATUS_METHOD = "platformclaw.agent.runtimeStatus";

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

export async function handleAgentRuntimeStatus({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): Promise<void> {
  if (!isRecord(params)) {
    invalidRequest(respond, "agent runtime status params must be an object");
    return;
  }
  const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  const workspace =
    typeof params.workspace === "string" && path.isAbsolute(params.workspace)
      ? path.resolve(params.workspace)
      : undefined;
  if (!agentId || !workspace || !configuredWorkspace(context, agentId, workspace)) {
    invalidRequest(respond, `agent or workspace mismatch: ${agentId || "unknown"}`);
    return;
  }

  try {
    // A writable catalog load crosses the same configured-owner admission path as the first turn.
    const snapshot = await context.loadGatewayModelCatalogSnapshot({
      agentId,
      workspaceDir: workspace,
      readOnly: false,
    });
    if (
      snapshot.agentId !== agentId ||
      !snapshot.workspaceDir ||
      path.resolve(snapshot.workspaceDir) !== workspace ||
      !configuredWorkspace(context, agentId, workspace)
    ) {
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
