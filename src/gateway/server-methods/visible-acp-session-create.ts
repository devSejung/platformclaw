import type { AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { AcpInitializationCleanupError } from "../../acp/control-plane/manager.types.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../../acp/policy.js";
import { canUseAcpProcessTransport } from "../../acp/runtime/process-transport.js";
import {
  deleteAcpSessionMetaExactLifecycle,
  readAcpSessionMeta,
} from "../../acp/runtime/session-meta.js";
import { resolveTargetAcpAgentId } from "../../agents/acp-spawn-target.js";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalAgentId } from "../../routing/session-key.js";
import {
  isVisibleAcpPendingSessionEntry,
  type TrustedVisibleAcpInitialization,
  VISIBLE_ACP_INITIALIZATION_OWNER,
  VisibleAcpInitializationCleanupError,
  type VisibleAcpPendingSessionEntry,
} from "../visible-acp-session-initialization.js";

function sameLifecycle(left: SessionEntry | undefined, right: SessionEntry): boolean {
  return left?.sessionId === right.sessionId && left?.lifecycleRevision === right.lifecycleRevision;
}

function assertCurrentVisibleAcpConfiguration(params: {
  cfg: OpenClawConfig;
  intent: TrustedVisibleAcpInitialization;
}): void {
  if (!isAcpEnabledByPolicy(params.cfg)) {
    throw new Error("ACP was disabled before visible session initialization completed");
  }
  const configAgentId = params.intent.configAgentId ?? params.intent.logicalAgentId;
  const configuredAgent = resolveAgentConfig(params.cfg, configAgentId);
  const personalTarget = params.intent.executionOwnerAgentId === params.intent.logicalAgentId;
  if (personalTarget) {
    if (
      !resolveAgentConfig(params.cfg, params.intent.logicalAgentId) ||
      !canUseAcpProcessTransport({
        executionOwnerAgentId: params.intent.logicalAgentId,
        agent: params.intent.runtimeAgentId,
      })
    ) {
      throw new Error("Personal ACP execution target is no longer available");
    }
  } else if (configuredAgent?.runtime?.type !== "acp") {
    throw new Error(
      `Configured agent "${params.intent.logicalAgentId}" is no longer an ACP runtime target`,
    );
  }
  const trustedRuntimeAgentId = normalizeOptionalAgentId(params.intent.runtimeAgentId);
  const currentTarget = resolveTargetAcpAgentId({
    requestedAgentId:
      params.intent.configAgentId ??
      (personalTarget ? params.intent.runtimeAgentId : params.intent.logicalAgentId),
    cfg: params.cfg,
  });
  if (
    !currentTarget.ok ||
    !trustedRuntimeAgentId ||
    currentTarget.agentId !== trustedRuntimeAgentId
  ) {
    throw new Error(
      `Configured ACP runtime mapping for "${params.intent.logicalAgentId}" changed before initialization`,
    );
  }
  const policyError = resolveAcpAgentPolicyError(params.cfg, trustedRuntimeAgentId);
  if (policyError) {
    throw policyError;
  }
}

async function retireExactInitializedRuntime(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  handle: AcpRuntimeHandle;
}): Promise<void> {
  const closed = await getAcpSessionManager().closeSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    reason: "visible-acp-init-failed",
    cacheOnly: true,
    expectedHandle: params.handle,
    discardPersistentState: true,
  });
  if (!closed.runtimeClosed) {
    throw new Error("exact initialized ACP runtime retirement was not confirmed");
  }
}

function clearExactInitializedSidecar(params: { sessionKey: string; entry: SessionEntry }): void {
  const lifecycleRevision = params.entry.lifecycleRevision?.trim();
  if (!lifecycleRevision) {
    throw new Error("visible ACP creation is missing its lifecycle revision");
  }
  deleteAcpSessionMetaExactLifecycle({
    sessionKey: params.sessionKey,
    lifecycleRevision,
  });
}

/**
 * Initializes the ACP runtime for a newly-created dashboard row while the
 * gateway lifecycle lock is still held. The caller owns exact row rollback;
 * this helper owns only the exact runtime handle and ACP sidecar it initialized.
 */
export async function initializeVisibleAcpCreatedSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
  intent: TrustedVisibleAcpInitialization;
}): Promise<SessionEntry> {
  if (
    !isVisibleAcpPendingSessionEntry(params.entry) ||
    params.entry.agentHarnessId !== params.intent.runtimeAgentId
  ) {
    throw new Error("visible ACP initialization requires its owned pending creation fence");
  }
  if (params.agentId !== params.intent.logicalAgentId) {
    throw new Error("visible ACP initialization target does not match the logical session agent");
  }
  if (!params.entry.sessionId?.trim() || !params.entry.lifecycleRevision?.trim()) {
    throw new Error("visible ACP initialization requires an exact created session lifecycle");
  }

  assertCurrentVisibleAcpConfiguration({ cfg: params.cfg, intent: params.intent });

  const manager = getAcpSessionManager();
  const configuredAcp = resolveAgentConfig(
    params.cfg,
    params.intent.configAgentId ?? params.intent.logicalAgentId,
  )?.runtime;
  const configuredAcpOptions = configuredAcp?.type === "acp" ? configuredAcp.acp : undefined;
  const cwd = params.intent.cwdExplicit
    ? params.intent.cwd
    : (normalizeOptionalString(configuredAcpOptions?.cwd) ??
      params.intent.cwd ??
      normalizeOptionalString(params.entry.spawnedCwd));
  const backendId =
    normalizeOptionalString(configuredAcpOptions?.backend) ??
    normalizeOptionalString(params.cfg.acp?.backend);
  let initializedHandle: AcpRuntimeHandle | undefined;
  try {
    const initialized = await manager.initializeSession({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agent: params.intent.runtimeAgentId,
      ...(params.intent.executionOwnerAgentId
        ? { executionOwnerAgentId: params.intent.executionOwnerAgentId }
        : {}),
      mode: "persistent",
      ...(params.intent.runtimeOptions ? { runtimeOptions: params.intent.runtimeOptions } : {}),
      ...(params.intent.modelExplicit !== undefined
        ? { modelExplicit: params.intent.modelExplicit }
        : {}),
      ...(cwd ? { cwd } : {}),
      ...(backendId ? { backendId } : {}),
    });
    initializedHandle = initialized.handle;

    const persistedMeta = readAcpSessionMeta({ cfg: params.cfg, sessionKey: params.sessionKey });
    if (
      !persistedMeta ||
      persistedMeta.agent !== params.intent.runtimeAgentId ||
      persistedMeta.mode !== "persistent" ||
      persistedMeta.executionOwnerAgentId !== params.intent.executionOwnerAgentId
    ) {
      throw new Error("visible ACP initialization did not persist the trusted runtime identity");
    }

    const updated = await updateSessionEntry(
      {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      (current) => {
        if (
          !sameLifecycle(current, params.entry) ||
          !isVisibleAcpPendingSessionEntry(current) ||
          current.agentHarnessId !== params.intent.runtimeAgentId
        ) {
          return null;
        }
        // updateSessionEntry is an additive patch: omitting a field preserves
        // its current value, while an explicit undefined clears the fence.
        const clearedFence: Partial<VisibleAcpPendingSessionEntry> = {
          initializationPending: undefined,
          initializationOwner: undefined,
          agentHarnessId: undefined,
        };
        return clearedFence;
      },
    );
    if (!updated || !sameLifecycle(updated, params.entry)) {
      throw new Error("visible ACP session lifecycle changed before initialization committed");
    }
    const initializedEntry = updated as VisibleAcpPendingSessionEntry;
    if (
      initializedEntry.initializationPending === true ||
      initializedEntry.initializationOwner === VISIBLE_ACP_INITIALIZATION_OWNER
    ) {
      throw new Error("visible ACP initialization fence did not clear");
    }
    return updated;
  } catch (error) {
    if (error instanceof AcpInitializationCleanupError) {
      throw new VisibleAcpInitializationCleanupError(error.initializationError, error.cleanupError);
    }
    try {
      if (initializedHandle) {
        await retireExactInitializedRuntime({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
          handle: initializedHandle,
        });
      }
      clearExactInitializedSidecar({ sessionKey: params.sessionKey, entry: params.entry });
    } catch (cleanupError) {
      throw new VisibleAcpInitializationCleanupError(error, cleanupError);
    }
    throw error;
  }
}
