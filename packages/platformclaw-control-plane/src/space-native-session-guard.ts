import {
  GATEWAY_CLIENT_IDS,
  normalizeGatewayClientId,
} from "@openclaw/gateway-protocol/client-info";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserGatewayRpc } from "./browser-gateway-contracts.js";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import { isSpaceConversationSession } from "./space-conversation-service.js";
import type { SqliteSpaceStore } from "./sqlite-spaces.js";

export type SpaceNativeSessionRequest = {
  agentId: string;
  sessionKey?: string;
  nativeTool: string;
  targetSessionKey?: string;
  targetLabel?: string;
  targetAgentId?: string;
  nativeAction?: string;
  broad: boolean;
};

const NATIVE_SESSION_TOOLS = new Set([
  "sessions",
  "sessions_history",
  "sessions_list",
  "sessions_search",
  "sessions_send",
  "sessions_spawn",
  "session_status",
]);
// Matches native sessions-resolution client aliases; these identify the trusted caller.
const CURRENT_CLIENT_ALIASES = new Set<string>([
  GATEWAY_CLIENT_IDS.TUI,
  GATEWAY_CLIENT_IDS.CLI,
  GATEWAY_CLIENT_IDS.WEBCHAT_UI,
  GATEWAY_CLIENT_IDS.CONTROL_UI,
  GATEWAY_CLIENT_IDS.MACOS_APP,
  GATEWAY_CLIENT_IDS.IOS_APP,
  GATEWAY_CLIENT_IDS.ANDROID_APP,
]);

function isNativeSessionKey(value: string): boolean {
  return (
    ["main", "global", "unknown", "current"].includes(value) ||
    /^(agent:|acp:|cron:|hook:|node-|node:)/u.test(value) ||
    value.includes(":group:") ||
    value.includes(":channel:")
  );
}

/** Native tools retain their policy except where they would bypass a registered Space boundary. */
export class SpaceNativeSessionGuard {
  constructor(
    private readonly spaces: SqliteSpaceStore,
    private readonly gateway: BrowserGatewayRpc,
  ) {}

  private caller(params: SpaceNativeSessionRequest): string | undefined {
    const owner = this.spaces.personalAgentOwner(params.agentId);
    const userId = owner === undefined ? undefined : this.spaces.userForAgent(params.agentId);
    const source = params.sessionKey;
    if (source && isSpaceConversationSession(source)) {
      if (!userId) {
        throw new ControlPlaneAuthorizationError("Space conversation unavailable");
      }
      const conversation = this.spaces.conversationForSession(userId, source, true);
      if (conversation.agentId !== params.agentId) {
        throw new ControlPlaneAuthorizationError("Space conversation unavailable");
      }
    }
    return userId;
  }

  private async resolve(params: Record<string, unknown>): Promise<string | undefined> {
    let result: unknown;
    try {
      result = await this.gateway.request("sessions.resolve", { ...params, allowMissing: true });
    } catch {
      // Ambiguity and upstream failure must never fall back to an unchecked raw selector.
      throw new ControlPlaneStateError("Session target unavailable; use an exact session key");
    }
    if (!isRecord(result) || typeof result.ok !== "boolean") {
      throw new ControlPlaneStateError("Session target resolution unavailable; retry");
    }
    if (!result.ok) {
      return undefined;
    }
    if (typeof result.key !== "string" || !result.key.trim()) {
      throw new ControlPlaneStateError("Session target resolution unavailable; retry");
    }
    return result.key.trim();
  }

  private async resolveTarget(params: SpaceNativeSessionRequest): Promise<string> {
    let target = params.targetSessionKey?.trim();
    if (target && CURRENT_CLIENT_ALIASES.has(normalizeGatewayClientId(target) ?? "")) {
      target = params.sessionKey;
    }
    if (target === "current") {
      target = params.sessionKey;
    }
    if (!target && params.targetLabel) {
      const key = await this.resolve({
        label: params.targetLabel,
        ...(params.targetAgentId ? { agentId: params.targetAgentId } : {}),
      });
      if (key) {
        return key;
      }
    } else {
      if (!target) {
        target =
          params.nativeTool === "sessions_send" && params.targetAgentId
            ? `agent:${params.targetAgentId}:main`
            : params.sessionKey;
      }
      if (target) {
        const key = await this.resolve({ key: target });
        if (key) {
          return key;
        }
        // Native sends may create an absent exact agent key (agent-session-prepare).
        // Only proven absence is allowed; reserved Space keys can never be minted here.
        if (
          params.nativeTool === "sessions_send" &&
          /^agent:[a-z0-9][a-z0-9_-]{0,63}:.+$/u.test(target) &&
          !isSpaceConversationSession(target) &&
          !this.spaces.registeredConversation(target)
        ) {
          return target;
        }
        if (!isNativeSessionKey(target)) {
          const byId = await this.resolve({
            sessionId: target,
            includeGlobal: true,
            includeUnknown: true,
          });
          if (byId) {
            return byId;
          }
        }
      }
    }
    throw new ControlPlaneStateError("Session target unavailable; use an exact session key");
  }

  async authorize(input: SpaceNativeSessionRequest): Promise<{ sessionKey?: string }> {
    // Native selection canonicalizes agent ids; check the same identity before dispatch.
    const params =
      input.targetAgentId === undefined
        ? input
        : { ...input, targetAgentId: normalizeAgentId(input.targetAgentId) };
    if (!NATIVE_SESSION_TOOLS.has(params.nativeTool)) {
      throw new ControlPlaneStateError("Unsupported native session tool");
    }
    const userId = this.caller(params);
    if (params.nativeTool === "sessions_spawn") {
      if (
        params.targetAgentId &&
        params.targetAgentId !== params.agentId &&
        this.spaces.personalAgentOwner(params.targetAgentId) !== undefined
      ) {
        throw new ControlPlaneAuthorizationError(
          "Cannot run another employee's personal agent; use your own agent and Space recall",
        );
      }
      return {};
    }
    const listing =
      params.nativeTool === "sessions_list" ||
      (params.nativeTool === "sessions_search" && !params.targetSessionKey);
    if (listing) {
      // Widened queries can observe registrations created after this preflight. Tree queries
      // also include Space roots parented to main, so fence already-revoked own children.
      if (params.broad || this.spaces.hasInaccessibleConversations(userId, params.agentId)) {
        throw new ControlPlaneAuthorizationError(
          "This broad native query could expose private Space sessions; use an exact own session or Space recall",
        );
      }
      return {};
    }
    if (params.nativeTool === "sessions" && params.nativeAction?.startsWith("group_")) {
      return {};
    }
    const sessionKey = await this.resolveTarget(params);
    if (this.caller(params) !== userId) {
      throw new ControlPlaneAuthorizationError("Session caller changed; retry");
    }
    const registered = this.spaces.registeredConversation(sessionKey);
    if (!registered) {
      if (isSpaceConversationSession(sessionKey)) {
        throw new ControlPlaneAuthorizationError("Space conversation unavailable");
      }
      return { sessionKey };
    }
    if (!userId) {
      throw new ControlPlaneAuthorizationError("Space conversation unavailable");
    }
    if (sessionKey !== params.sessionKey) {
      throw new ControlPlaneAuthorizationError(
        "Space conversation unavailable through cross-session native tools; use Space recall or open your own tab",
      );
    }
    const write =
      params.nativeTool === "sessions_send" ||
      params.nativeTool === "sessions" ||
      (params.nativeTool === "session_status" && params.nativeAction === "patch");
    this.spaces.conversationForSession(userId, sessionKey, write);
    if (
      params.nativeTool === "sessions" &&
      ["reset", "delete"].includes(params.nativeAction ?? "")
    ) {
      throw new ControlPlaneStateError(
        "Shared conversation history is retained; create a new conversation instead",
      );
    }
    return { sessionKey };
  }
}
