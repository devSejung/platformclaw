// Tool-event recipients retain the exact admitted session route across agent run IDs.
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayClient, GatewayRequestContext } from "./shared-types.js";

export function registerChatSendToolEventRecipients(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  runId: string;
}): void {
  const connId = typeof params.client?.connId === "string" ? params.client.connId : undefined;
  const wantsToolEvents = hasGatewayClientCap(
    params.client?.connect?.caps,
    GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
  );
  if (connId && wantsToolEvents) {
    params.context.registerToolEventRecipient(params.runId, connId);
    // Register for any other active runs *in the same session* so
    // late-joining clients (e.g. page refresh mid-response) receive
    // in-progress tool events without leaking cross-session data.
    const defaultAgentId = resolveDefaultAgentId(params.cfg);
    const selectedGlobalAgentId =
      params.sessionKey === "global" ? (params.agentId ?? defaultAgentId) : undefined;
    for (const [activeRunId, active] of params.context.chatAbortControllers) {
      const activeGlobalAgentId =
        active.sessionKey === "global" ? (active.agentId ?? defaultAgentId) : undefined;
      const sameSelectedGlobalAgent =
        params.sessionKey === "global" &&
        selectedGlobalAgentId !== undefined &&
        activeGlobalAgentId === selectedGlobalAgentId;
      const sameSession =
        active.sessionKey === params.sessionKey &&
        (params.sessionKey !== "global" || sameSelectedGlobalAgent);
      if (activeRunId !== params.runId && sameSession) {
        params.context.registerToolEventRecipient(activeRunId, connId);
      }
    }
  }
}
