/**
 * Harness-facing materialization of requester-scoped MCP tools.
 * Static MCP stays harness-native; this path never opens static transports.
 */
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tools.js";
import {
  buildBundleMcpToolsFromCatalog,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import {
  getAdvertisedScopedMcpCatalog,
  getOrCreateRequesterScopedMcpRuntime,
} from "./agent-bundle-mcp-runtime.js";
import {
  resolveConversationCapabilityProfile,
  type ConversationCapabilityProfileParams,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { AnyAgentTool } from "./tools/common.js";

type RequesterScopedHarnessMcpTools = {
  /** Executable tools for this turn (live binding or not-connected stubs). */
  tools: AnyAgentTool[];
  /**
   * Session-stable advertised tool surface for dynamic-tool fingerprints.
   * Identical for every sender once the session has observed a scoped catalog.
   */
  advertisedTools: AnyAgentTool[];
  dispose: () => Promise<void>;
};

type MaterializeRequesterScopedMcpToolsForHarnessRunParams = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  requesterSenderId?: string | null;
  agentId?: string | null;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
  agentAccountId?: string | null;
  messageChannel?: string | null;
  reservedToolNames?: Iterable<string>;
  toolsAllow?: string[];
  /** When set, applies the same final effective tool policy as the embedded runner. */
  conversationCapabilityProfile?: ResolvedConversationCapabilityProfile;
  /** Builds a capability profile when conversationCapabilityProfile is omitted. */
  policyContext?: Omit<ConversationCapabilityProfileParams, "runtimeToolAllowlist">;
  warn?: (message: string) => void;
};

function notConnectedToolResult(serverName: string, toolName: string) {
  const message = `Requester has not connected MCP server "${serverName}" (tool "${toolName}") for this turn.`;
  return {
    content: [{ type: "text" as const, text: message }],
    details: {
      status: "error" as const,
      error: message,
      mcpServer: serverName,
      mcpTool: toolName,
    },
  };
}

function harnessMcpToolIdentity(tool: AnyAgentTool): string {
  // Both surfaces come from the MCP catalog factory; provider-safe names may
  // be reassigned when a session disables a colliding server or tool.
  const mcp = getPluginToolMeta(tool)!.mcp!;
  return JSON.stringify([mcp.serverName, mcp.operation, mcp.toolName]);
}

function applyHarnessToolPolicy(
  tools: AnyAgentTool[],
  params: MaterializeRequesterScopedMcpToolsForHarnessRunParams,
): AnyAgentTool[] {
  if (tools.length === 0) {
    return tools;
  }
  // Advertised schemas survive missing credentials and disabled servers. Apply
  // this turn's restrictions before cached tools can reenter the harness surface.
  const sessionAllowed = tools.filter((tool) => {
    const mcp = getPluginToolMeta(tool)?.mcp;
    if (!mcp) {
      return true;
    }
    const servers = params.toolOverrides?.mcpServers;
    if (servers && Object.hasOwn(servers, mcp.serverName) && servers[mcp.serverName] === false) {
      return false;
    }
    const denied = params.toolOverrides?.mcpToolsDeny;
    return !(
      denied &&
      Object.hasOwn(denied, mcp.serverName) &&
      denied[mcp.serverName]?.includes(mcp.toolName)
    );
  });
  const allowed = applyEmbeddedAttemptToolsAllow(sessionAllowed, params.toolsAllow, {
    toolMeta: (tool) => getPluginToolMeta(tool),
  });
  const profile =
    params.conversationCapabilityProfile ??
    (params.policyContext
      ? resolveConversationCapabilityProfile({
          ...params.policyContext,
          runtimeToolAllowlist: params.toolsAllow,
        })
      : undefined);
  if (!profile) {
    return allowed;
  }
  return applyFinalEffectiveToolPolicy({
    bundledTools: allowed,
    config: params.policyContext?.config ?? params.cfg,
    conversationCapabilityProfile: profile,
    warn: params.warn ?? (() => undefined),
  });
}

/**
 * Materialize requester-scoped MCP tools for a harness run (e.g. Codex dynamic tools).
 * The manager publishes catalogs only while their declared configuration is current.
 * Before any requester resolves in the session, returns undefined (nothing to advertise).
 */
export async function materializeRequesterScopedMcpToolsForHarnessRun(
  params: MaterializeRequesterScopedMcpToolsForHarnessRunParams,
): Promise<RequesterScopedHarnessMcpTools | undefined> {
  const scopedRuntime = await getOrCreateRequesterScopedMcpRuntime({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
    requesterSenderId: params.requesterSenderId,
    agentId: params.agentId,
    toolOverrides: params.toolOverrides,
    agentAccountId: params.agentAccountId,
    messageChannel: params.messageChannel,
  });

  let liveRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  if (scopedRuntime) {
    liveRuntime = await materializeBundleMcpToolsForRun({
      runtime: scopedRuntime,
      reservedToolNames: params.reservedToolNames,
    });
  }

  const advertisedCatalog = getAdvertisedScopedMcpCatalog(params.sessionId);
  if (!advertisedCatalog || advertisedCatalog.tools.length === 0) {
    await liveRuntime?.dispose();
    return undefined;
  }

  const reservedToolNames = params.reservedToolNames
    ? Array.from(params.reservedToolNames)
    : undefined;
  const advertisedTools = buildBundleMcpToolsFromCatalog({
    catalog: advertisedCatalog,
    reservedToolNames,
    createExecute: (tool) => async () => notConnectedToolResult(tool.serverName, tool.toolName),
  });
  const liveByIdentity = new Map(
    (liveRuntime?.tools ?? []).map((tool) => [harnessMcpToolIdentity(tool), tool]),
  );
  // Bind by server/operation/raw name so a reused safe name cannot borrow
  // another server's authority. Keep the advertised schema and its metadata.
  const tools = advertisedTools.map((tool) => {
    const live = liveByIdentity.get(harnessMcpToolIdentity(tool));
    if (!live) {
      return tool;
    }
    const bound = { ...tool, execute: live.execute };
    setPluginToolMeta(bound, getPluginToolMeta(tool)!);
    return bound;
  });

  const filteredTools = applyHarnessToolPolicy(tools, params);
  const filteredAdvertised = applyHarnessToolPolicy(advertisedTools, params);
  // Policy must keep both lists aligned by name for fingerprint stability.
  const allowedNames = new Set(filteredAdvertised.map((tool) => tool.name));
  const executableTools = filteredTools.filter((tool) => allowedNames.has(tool.name));

  let disposed = false;
  return {
    tools: executableTools,
    advertisedTools: filteredAdvertised,
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      await liveRuntime?.dispose();
    },
  };
}
