import {
  GATEWAY_CLIENT_IDS,
  normalizeGatewayClientId,
} from "@openclaw/gateway-protocol/client-info";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import type { BrowserGatewayRpc } from "./browser-gateway-contracts.js";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import { isSpaceConversationSession } from "./space-contracts.js";
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

type ResolvedNativeSessionTarget = {
  key: string;
  agentId?: string;
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

function isLegacySpaceSessionKey(value: string): boolean {
  return /^agent:space-[a-f0-9-]{36}:space:[a-f0-9-]{36}$/u.test(value);
}

const MAX_SPACE_SESSION_ANCESTRY_DEPTH = 32;

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

  private bareSessionAgentId(
    params: SpaceNativeSessionRequest,
    historyAgentId?: string,
  ): string | undefined {
    switch (params.nativeTool) {
      case "sessions_history":
        return historyAgentId;
      case "sessions_search":
        return normalizeAgentId(params.agentId);
      case "session_status":
        // Status derives bare-key ownership from its caller key, not the hook agent override.
        return parseAgentSessionKey(params.sessionKey)?.agentId;
      default:
        // Sends and mutations dispatch only a key, so bare keys use the default store.
        return undefined;
    }
  }

  private targetAgentScope(params: SpaceNativeSessionRequest, target: string): string | undefined {
    if (parseAgentSessionKey(target)?.agentId) {
      return undefined;
    }
    return this.bareSessionAgentId(
      params,
      normalizeAgentId(params.targetAgentId ?? params.agentId),
    );
  }

  private resolvedTarget(
    params: SpaceNativeSessionRequest,
    key: string,
    agentId?: string,
  ): ResolvedNativeSessionTarget {
    const targetAgentId = this.bareSessionAgentId(params, agentId);
    return {
      key,
      ...(!parseAgentSessionKey(key)?.agentId && targetAgentId ? { agentId: targetAgentId } : {}),
    };
  }

  private async resolveLineage(
    sessionKey: string,
    agentId?: string,
  ): Promise<
    | {
        key: string;
        parentSessionKey?: string;
        parentSessionAgentId?: string;
        spawnedBy?: string;
        spawnedByAgentId?: string;
      }
    | undefined
  > {
    let result: unknown;
    try {
      result = await this.gateway.request("sessions.resolve", {
        key: sessionKey,
        allowMissing: true,
        includeLineage: true,
        ...(agentId ? { agentId } : {}),
      });
    } catch {
      throw new ControlPlaneStateError("Session ancestry unavailable; retry");
    }
    if (!isRecord(result) || typeof result.ok !== "boolean") {
      throw new ControlPlaneStateError("Session ancestry unavailable; retry");
    }
    if (!result.ok) {
      return undefined;
    }
    if (typeof result.key !== "string") {
      throw new ControlPlaneStateError("Session ancestry unavailable; retry");
    }
    const key = result.key.trim();
    if (!key) {
      throw new ControlPlaneStateError("Session ancestry unavailable; retry");
    }
    const lineage = isRecord(result.lineage) ? result.lineage : {};
    return {
      key,
      ...(typeof lineage.parentSessionKey === "string" && lineage.parentSessionKey.trim()
        ? { parentSessionKey: lineage.parentSessionKey.trim() }
        : {}),
      ...(typeof lineage.parentSessionAgentId === "string" && lineage.parentSessionAgentId.trim()
        ? { parentSessionAgentId: normalizeAgentId(lineage.parentSessionAgentId) }
        : {}),
      ...(typeof lineage.spawnedBy === "string" && lineage.spawnedBy.trim()
        ? { spawnedBy: lineage.spawnedBy.trim() }
        : {}),
      ...(typeof lineage.spawnedByAgentId === "string" && lineage.spawnedByAgentId.trim()
        ? { spawnedByAgentId: normalizeAgentId(lineage.spawnedByAgentId) }
        : {}),
    };
  }

  private async assertNotSpaceDescendant(
    sessionKey: string,
    fallbackAgentId: string | undefined,
    allowMissingTarget = false,
  ): Promise<void> {
    const pending: Array<{ key: string; depth: number; agentId?: string }> = [
      {
        key: sessionKey,
        depth: 0,
        agentId: parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId,
      },
    ];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.shift()!;
      const identity = parseAgentSessionKey(current.key)?.agentId
        ? current.key
        : `${current.agentId ?? ""}\0${current.key}`;
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      if (current.depth >= MAX_SPACE_SESSION_ANCESTRY_DEPTH) {
        throw new ControlPlaneStateError("Session ancestry is too deep; retry with Space recall");
      }
      const lineage = await this.resolveLineage(current.key, current.agentId);
      if (!lineage) {
        if (current.depth === 0 && allowMissingTarget) {
          return;
        }
        throw new ControlPlaneStateError("Session ancestry unavailable; retry");
      }
      const parents = [
        [lineage.parentSessionKey, lineage.parentSessionAgentId] as const,
        [lineage.spawnedBy, lineage.spawnedByAgentId] as const,
      ];
      for (const [parent, referenceAgentId] of parents) {
        if (!parent || parent === current.key) {
          continue;
        }
        if (isSpaceConversationSession(parent) || isLegacySpaceSessionKey(parent)) {
          throw new ControlPlaneAuthorizationError(
            "Space descendant raw sessions are private; use Space recall for shared Q&A",
          );
        }
        const parentAgentId = parseAgentSessionKey(parent)?.agentId ?? referenceAgentId;
        if (!parentAgentId && !parseAgentSessionKey(parent)) {
          throw new ControlPlaneStateError("Session ancestry owner unavailable; retry");
        }
        pending.push({
          key: parent,
          depth: current.depth + 1,
          agentId: parentAgentId,
        });
      }
    }
  }

  private async resolveTarget(
    params: SpaceNativeSessionRequest,
  ): Promise<ResolvedNativeSessionTarget> {
    let target = params.targetSessionKey?.trim();
    if (target && CURRENT_CLIENT_ALIASES.has(normalizeGatewayClientId(target) ?? "")) {
      target = params.sessionKey;
    }
    if (target === "current") {
      target = params.sessionKey;
    }
    if (!target && params.targetLabel) {
      const targetAgentId = params.targetAgentId
        ? normalizeAgentId(params.targetAgentId)
        : undefined;
      const key = await this.resolve({
        label: params.targetLabel,
        ...(targetAgentId ? { agentId: targetAgentId } : {}),
      });
      if (key) {
        return this.resolvedTarget(params, key, targetAgentId);
      }
    } else {
      if (!target) {
        target =
          params.nativeTool === "sessions_send" && params.targetAgentId
            ? `agent:${params.targetAgentId}:main`
            : params.sessionKey;
      }
      if (target) {
        const targetAgentId = this.targetAgentScope(params, target);
        const key = await this.resolve({
          key: target,
          ...(targetAgentId ? { agentId: targetAgentId } : {}),
        });
        if (key) {
          return this.resolvedTarget(params, key, targetAgentId);
        }
        // Native sends may create an absent exact agent key (agent-session-prepare).
        // Only proven absence is allowed; reserved Space keys can never be minted here.
        if (
          params.nativeTool === "sessions_send" &&
          /^agent:[a-z0-9][a-z0-9_-]{0,63}:.+$/u.test(target) &&
          !isSpaceConversationSession(target) &&
          !this.spaces.registeredConversation(target)
        ) {
          return { key: target };
        }
        if (!isNativeSessionKey(target)) {
          // Native ID lookup spans agents unless the caller explicitly selects one.
          const explicitAgentId = params.targetAgentId;
          const byId = await this.resolve({
            sessionId: target,
            includeGlobal: true,
            includeUnknown: true,
            ...(explicitAgentId ? { agentId: explicitAgentId } : {}),
          });
          if (byId) {
            return this.resolvedTarget(params, byId, explicitAgentId);
          }
        }
      }
    }
    throw new ControlPlaneStateError("Session target unavailable; use an exact session key");
  }

  async authorize(
    input: SpaceNativeSessionRequest,
  ): Promise<{ sessionKey?: string; agentId?: string }> {
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
    const target = await this.resolveTarget(params);
    const sessionKey = target.key;
    if (this.caller(params) !== userId) {
      throw new ControlPlaneAuthorizationError("Session caller changed; retry");
    }
    if (isLegacySpaceSessionKey(sessionKey)) {
      throw new ControlPlaneAuthorizationError(
        "Legacy Space raw sessions are private; use Space recall for shared Q&A",
      );
    }
    const registered = this.spaces.registeredConversation(sessionKey);
    if (!registered) {
      if (isSpaceConversationSession(sessionKey)) {
        throw new ControlPlaneAuthorizationError("Space conversation unavailable");
      }
      await this.assertNotSpaceDescendant(
        sessionKey,
        target.agentId,
        params.nativeTool === "sessions_send",
      );
      return { sessionKey, ...(target.agentId ? { agentId: target.agentId } : {}) };
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
    return { sessionKey, ...(target.agentId ? { agentId: target.agentId } : {}) };
  }
}
