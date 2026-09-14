import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAcpAgentPolicyError } from "../../acp/policy.js";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import {
  DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
} from "../../config/agent-limits.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { resolveAcpSpawnRuntimePlan } from "../acp-spawn-runtime-policy.js";
import {
  resolveAcpSpawnRuntimeOptions,
  resolveRuntimeCwdForAcpSpawn,
} from "../acp-spawn-runtime.js";
import { resolveTargetAcpAgentId } from "../acp-spawn-target.js";
import { listAgentIds, resolveAgentConfig } from "../agent-scope.js";
import { reserveChildAdmissionSlot } from "../child-admission.js";
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
} from "../inherited-tool-deny.js";
import { resolveSpawnedWorkspaceInheritance } from "../spawned-context.js";
import { getSubagentDepthFromSessionStore } from "../subagent-depth.js";
import { countActiveRunsForSession, registerSubagentRun } from "../subagent-registry.js";
import { resolveSubagentSpawnOwnership } from "../subagent-spawn-ownership.js";
import { resolveConfiguredSubagentRunTimeoutSeconds } from "../subagent-spawn-plan.js";
import { resolveSubagentTargetPolicy } from "../subagent-target-policy.js";
import { readStringParam, ToolInputError } from "./common.js";
import {
  callInProcessGatewayTool,
  callInProcessGatewayToolWithCreation,
  type InProcessGatewayCaller,
} from "./in-process-gateway.js";

export type VisibleAcpSpawnOptions = {
  agentSessionKey?: string;
  completionOwnerKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  requesterAgentIdOverride?: string;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  callGateway?: InProcessGatewayCaller;
  registerRun?: typeof registerSubagentRun;
  countActiveRuns?: typeof countActiveRunsForSession;
};

type VisibleAcpCreatedLifecycle = {
  childSessionKey: string;
  sessionId?: string;
  lifecycleRevision?: string;
};

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "error";
}

function resolveAcpUnavailableMessage(opts: VisibleAcpSpawnOptions | undefined): string {
  if (opts?.sandboxed === true) {
    return 'runtime="acp" is unavailable from sandboxed sessions because ACP sessions run on the host. Use runtime="subagent".';
  }
  if (opts?.config?.acp?.enabled === false) {
    return 'runtime="acp" is unavailable because ACP is disabled by policy (`acp.enabled=false`). Use runtime="subagent".';
  }
  return 'runtime="acp" is unavailable in this session because no ACP runtime backend is loaded. Enable the acpx plugin or use runtime="subagent".';
}

async function deleteVisibleAcpSession(
  gatewayCall: InProcessGatewayCaller,
  created: VisibleAcpCreatedLifecycle,
): Promise<boolean> {
  const expectedSessionId = normalizeOptionalString(created.sessionId);
  const expectedLifecycleRevision = normalizeOptionalString(created.lifecycleRevision);
  if (!expectedSessionId || !expectedLifecycleRevision) {
    return false;
  }
  try {
    await gatewayCall("sessions.delete", {
      key: created.childSessionKey,
      expectedSessionId,
      expectedLifecycleRevision,
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
    return true;
  } catch {
    return false;
  }
}

function assertVisibleAcpParameters(raw: Record<string, unknown>): void {
  const mode = raw.mode;
  const unsupported = [
    [
      "thinking",
      readStringParam(raw, "thinking"),
      "thinking overrides are not wired to visible ACP",
    ],
    ["thread", raw.thread === true ? true : undefined, "visible sessions route to the dashboard"],
    [
      "mode",
      mode === undefined || mode === "run" ? undefined : mode,
      'visible ACP accepts only the spawned-task envelope mode="run"; the dashboard ACP session remains persistent',
    ],
    [
      "context",
      raw.context === "fork" ? "fork" : undefined,
      "visible ACP does not fork transcripts",
    ],
    [
      "lightContext",
      raw.lightContext === true ? true : undefined,
      "bootstrap staging is unavailable",
    ],
    [
      "attachments",
      Array.isArray(raw.attachments) ? raw.attachments : undefined,
      "attachment staging is unavailable",
    ],
    ["attachAs", raw.attachAs, "attachment staging is unavailable"],
    [
      "resumeSessionId",
      readStringParam(raw, "resumeSessionId"),
      "the dashboard key owns resume state",
    ],
    ["streamTo", raw.streamTo, "visible ACP streams through normal dashboard chat"],
    [
      "worktree",
      raw.worktree === true ? true : undefined,
      "visible ACP worktrees are not supported",
    ],
    [
      "worktreeName",
      readStringParam(raw, "worktreeName"),
      "visible ACP worktrees are not supported",
    ],
    [
      "worktreeBaseRef",
      readStringParam(raw, "worktreeBaseRef"),
      "visible ACP worktrees are not supported",
    ],
  ] as const;
  const provided = unsupported.filter(([, value]) => value !== undefined);
  if (provided.length > 0) {
    throw new ToolInputError(
      `Parameters unavailable with visible=true runtime="acp": ${provided
        .map(([name, , reason]) => `${name}: ${reason}`)
        .join("; ")}`,
    );
  }
}

export async function spawnVisibleAcpSession(params: {
  raw: Record<string, unknown>;
  task: string;
  taskName?: string;
  label: string;
  requestedAgentId?: string;
  runTimeoutSeconds?: number;
  sandbox: "inherit" | "require";
  modelOverride?: string;
  options?: VisibleAcpSpawnOptions;
}): Promise<Record<string, unknown>> {
  assertVisibleAcpParameters(params.raw);
  const cfg = params.options?.config ?? getRuntimeConfig();
  if (!isAcpRuntimeSpawnAvailable({ config: cfg, sandboxed: params.options?.sandboxed })) {
    return { status: "error", error: resolveAcpUnavailableMessage(params.options) };
  }

  const requestedLogicalAgentId = normalizeOptionalString(params.requestedAgentId);
  if (!requestedLogicalAgentId) {
    return {
      status: "error",
      error:
        'sessions_spawn(runtime="acp", visible=true) requires agentId for a configured logical ACP agent.',
    };
  }
  const logicalAgentId = normalizeAgentId(requestedLogicalAgentId);
  const logicalAgent = resolveAgentConfig(cfg, logicalAgentId);
  if (logicalAgent?.runtime?.type !== "acp") {
    return {
      status: "error",
      error:
        `Visible ACP agentId "${logicalAgentId}" must name a configured agent with ` +
        'runtime.type="acp"; raw ACP harness ids are supported only by non-visible ACP spawns.',
    };
  }
  const target = resolveTargetAcpAgentId({ requestedAgentId: logicalAgentId, cfg });
  if (!target.ok) {
    return { status: "error", error: target.error };
  }
  const policyError = resolveAcpAgentPolicyError(cfg, target.agentId);
  if (policyError) {
    return { status: "forbidden", error: policyError.message };
  }
  const deniedTool = findAcpUnsupportedInheritedToolDeny(params.options?.inheritedToolDenylist);
  if (deniedTool) {
    return { status: "forbidden", error: formatAcpInheritedToolDenyError(deniedTool) };
  }
  const missingAllowedTool = findAcpUnsupportedInheritedToolAllow(
    params.options?.inheritedToolAllowlist,
  );
  if (missingAllowedTool) {
    return { status: "forbidden", error: formatAcpInheritedToolAllowError(missingAllowedTool) };
  }

  const ownership = resolveSubagentSpawnOwnership({
    cfg,
    agentSessionKey: params.options?.agentSessionKey,
    completionOwnerKey: params.options?.completionOwnerKey,
  });
  const requesterKey = ownership.controllerSessionKey;
  const requesterAgentId = normalizeAgentId(
    params.options?.requesterAgentIdOverride ?? parseAgentSessionKey(requesterKey)?.agentId,
  );
  const targetPolicy = resolveSubagentTargetPolicy({
    requesterAgentId,
    targetAgentId: logicalAgentId,
    requestedAgentId: params.requestedAgentId,
    allowAgents:
      resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
      cfg.agents?.defaults?.subagents?.allowAgents,
    configuredAgentIds: listAgentIds(cfg),
  });
  if (!targetPolicy.ok) {
    return { status: "forbidden", error: targetPolicy.error };
  }
  const callerDepth = getSubagentDepthFromSessionStore(requesterKey, { cfg });
  const maxDepth =
    cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (callerDepth >= maxDepth) {
    return {
      status: "forbidden",
      error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxDepth})`,
    };
  }
  const runtimePlan = resolveAcpSpawnRuntimePlan({
    cfg,
    requesterSessionKey: requesterKey,
    requesterSandboxed: params.options?.sandboxed,
    sandbox: params.sandbox,
    executionOwnerAgentId: requesterAgentId,
    targetAgentId: target.agentId,
  });
  if (!runtimePlan.ok) {
    return { status: "forbidden", error: runtimePlan.error };
  }
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });
  const runtimeOptions = resolveAcpSpawnRuntimeOptions({
    cfg,
    targetAgentId: target.agentId,
    configAgentId: logicalAgentId,
    model: params.modelOverride,
    runTimeoutSeconds,
  });
  if (!runtimeOptions.ok) {
    return { status: "error", error: runtimeOptions.error };
  }
  const explicitCwd = readStringParam(params.raw, "cwd");
  const resolvedCwd = resolveSpawnedWorkspaceInheritance({
    config: cfg,
    targetAgentId: logicalAgentId,
    requesterSessionKey: params.options?.agentSessionKey,
    explicitWorkspaceDir: explicitCwd,
  });
  let runtimeCwd: string | undefined;
  try {
    runtimeCwd = await resolveRuntimeCwdForAcpSpawn({ resolvedCwd, explicitCwd });
  } catch (error) {
    return {
      status: "error",
      error: `Failed to resolve visible ACP cwd: ${summarizeError(error)}`,
    };
  }

  const maxChildren =
    cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT;
  const reservation = reserveChildAdmissionSlot({
    controllerSessionKey: requesterKey,
    resolveAdmission: (pendingChildren) => {
      const activeChildren =
        (params.options?.countActiveRuns ?? countActiveRunsForSession)(requesterKey, {
          collect: false,
        }) + pendingChildren;
      return activeChildren >= maxChildren
        ? { ok: false as const, activeChildren }
        : { ok: true as const };
    },
  });
  if (!reservation.ok) {
    return {
      status: "forbidden",
      error: `sessions_spawn has reached max active children for this session (${reservation.activeChildren}/${maxChildren})`,
    };
  }

  try {
    const gatewayCall = params.options?.callGateway ?? callInProcessGatewayTool;
    const createGatewayCall: InProcessGatewayCaller =
      params.options?.callGateway ??
      ((method, requestParams) =>
        callInProcessGatewayToolWithCreation(method, requestParams, {
          via: "spawn",
          actor: { type: "agent", id: requesterKey },
          completionOwnerSessionKey: ownership.completionRequesterSessionKey,
          inheritedToolPolicy: {
            version: 1,
            allow: [...(params.options?.inheritedToolAllowlist ?? [])],
            deny: [...(params.options?.inheritedToolDenylist ?? [])],
          },
          acpInitialization: {
            logicalAgentId,
            runtimeAgentId: target.agentId,
            ...(runtimePlan.executionOwnerAgentId
              ? { executionOwnerAgentId: runtimePlan.executionOwnerAgentId }
              : {}),
            ...(runtimeOptions.runtimeOptions
              ? { runtimeOptions: runtimeOptions.runtimeOptions }
              : {}),
            modelExplicit: runtimeOptions.modelExplicit,
            ...(runtimeCwd ? { cwd: runtimeCwd } : {}),
            cwdExplicit: Boolean(normalizeOptionalString(explicitCwd)),
          },
        }));
    const response = await createGatewayCall<{
      key?: string;
      sessionId?: string;
      lifecycleRevision?: string;
      runStarted?: boolean;
      runId?: string;
      runError?: unknown;
    }>("sessions.create", {
      agentId: logicalAgentId,
      ...(params.label ? { label: params.label } : {}),
      task: params.task,
      parentSessionKey: requesterKey,
      spawnDepth: callerDepth + 1,
      ...(runtimeCwd ? { cwd: runtimeCwd } : {}),
    });
    const childSessionKey = response.key?.trim();
    const createdLifecycle = childSessionKey
      ? {
          childSessionKey,
          sessionId: normalizeOptionalString(response.sessionId),
          lifecycleRevision: normalizeOptionalString(response.lifecycleRevision),
        }
      : undefined;
    const runId = response.runId?.trim();
    const runError = response.runError
      ? summarizeError(response.runError)
      : "Visible ACP run failed";
    if (!childSessionKey || !createdLifecycle) {
      return { status: "error", error: runError };
    }
    if (response.runStarted !== true) {
      const cleaned = await deleteVisibleAcpSession(gatewayCall, createdLifecycle);
      return {
        status: "error",
        error: cleaned
          ? runError
          : `${runError}. Exact session cleanup was not confirmed; session kept.`,
        childSessionKey,
      };
    }
    if (!runId) {
      try {
        await gatewayCall("sessions.abort", { key: childSessionKey, agentId: logicalAgentId });
      } catch {
        // Best-effort stop before exact cleanup.
      }
      const cleaned = await deleteVisibleAcpSession(gatewayCall, createdLifecycle);
      return {
        status: "error",
        error: cleaned
          ? runError
          : `${runError}. Exact session cleanup was not confirmed; session kept.`,
      };
    }
    try {
      (params.options?.registerRun ?? registerSubagentRun)({
        runId,
        childSessionKey,
        controllerSessionKey: ownership.controllerSessionKey,
        requesterSessionKey: ownership.completionRequesterSessionKey,
        requesterOrigin: normalizeDeliveryContext({
          channel: params.options?.agentChannel,
          accountId: params.options?.agentAccountId,
          to:
            params.options?.currentMessagingTarget ??
            params.options?.currentChannelId ??
            params.options?.agentTo,
          threadId: params.options?.currentThreadTs ?? params.options?.agentThreadId,
        }),
        requesterDisplayKey: ownership.completionRequesterDisplayKey,
        task: params.task,
        taskName: params.taskName,
        agentId: logicalAgentId,
        requesterAgentId: params.options?.requesterAgentIdOverride,
        cleanup: "keep",
        label: params.label || undefined,
        runTimeoutSeconds,
        expectsCompletionMessage: params.raw.expectsCompletionMessage !== false,
        spawnMode: "run",
      });
    } catch (error) {
      let abortResponse: { abortedRunId?: string | null };
      try {
        abortResponse = await gatewayCall<{ abortedRunId?: string | null }>("sessions.abort", {
          key: childSessionKey,
          runId,
          agentId: logicalAgentId,
        });
      } catch (abortError) {
        return {
          status: "error",
          error: `Visible ACP run registration failed: ${summarizeError(error)}. Run abort failed: ${summarizeError(abortError)}. Session kept.`,
          childSessionKey,
          runId,
        };
      }
      if (abortResponse.abortedRunId !== runId) {
        return {
          status: "error",
          error: `Visible ACP run registration failed: ${summarizeError(error)}. Run abort unconfirmed. Session kept.`,
          childSessionKey,
          runId,
        };
      }
      const cleaned = await deleteVisibleAcpSession(gatewayCall, createdLifecycle);
      return {
        status: "error",
        error: cleaned
          ? `Visible ACP run registration failed: ${summarizeError(error)}. Run aborted; exact lifecycle cleanup completed.`
          : `Visible ACP run registration failed: ${summarizeError(error)}. Run aborted; exact lifecycle cleanup was not confirmed, so the session was kept.`,
        childSessionKey,
        runId,
      };
    }
    return {
      status: "accepted",
      childSessionKey,
      runId,
      mode: "run",
      cleanup: "keep",
    };
  } finally {
    reservation.release();
  }
}
