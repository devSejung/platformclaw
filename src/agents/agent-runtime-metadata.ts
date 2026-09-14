/** Resolves agent runtime metadata from model/provider policy and ACP session overlays. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyAcpRuntimeOverlay, type AgentRuntimeMetadata } from "./acp-runtime-overlay.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { resolvePersistedSessionRuntimeId } from "./session-runtime-compat.js";

/** Resolves the runtime id/source that should be reported for a model-backed agent session. */
export function resolveModelAgentRuntimeMetadata(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  model?: string;
  sessionKey?: string;
  sessionEntry?: Parameters<typeof resolvePersistedSessionRuntimeId>[0];
  /** True when persisted ACP metadata owns this session's runtime. */
  acpRuntime?: boolean;
  /**
   * ACP backend identifier from persisted session metadata. The overlay reports
   * it as the runtime id instead of the generic fallback "acpx" so registered
   * non-default ACP backends are classified correctly.
   */
  acpBackend?: string;
}): AgentRuntimeMetadata {
  const persistedRuntimeId = resolvePersistedSessionRuntimeId(params.sessionEntry);
  if (persistedRuntimeId && !isDefaultAgentRuntimeId(persistedRuntimeId)) {
    return applyAcpRuntimeOverlay(
      { id: persistedRuntimeId, source: "session" },
      params.sessionKey,
      params.acpRuntime,
      params.acpBackend,
    );
  }
  const resolved =
    params.provider && params.model
      ? { provider: params.provider, model: params.model }
      : resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const policy = resolveAgentHarnessPolicy({
    provider: resolved.provider,
    modelId: resolved.model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const meta: AgentRuntimeMetadata = {
    id: policy.runtime,
    source: policy.runtimeSource ?? "implicit",
  };
  return applyAcpRuntimeOverlay(meta, params.sessionKey, params.acpRuntime, params.acpBackend);
}
