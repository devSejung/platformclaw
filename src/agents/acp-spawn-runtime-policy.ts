import { canUseAcpProcessTransport } from "../acp/runtime/process-transport.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { resolveSpawnSandboxError } from "./spawn-plan.js";

type AcpSpawnRuntimePlan =
  | { ok: true; executionOwnerAgentId?: string }
  | { ok: false; error: string };

export function resolveAcpSpawnRuntimePlan(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  requesterSandboxed?: boolean;
  sandbox?: "inherit" | "require";
  executionOwnerAgentId?: string;
  targetAgentId?: string;
}): AcpSpawnRuntimePlan {
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterSessionKey,
  });
  const requesterSandboxed = params.requesterSandboxed === true || requesterRuntime.sandboxed;
  const backend = getAcpRuntimeBackend(params.cfg.acp?.backend);
  // Process transport discovery is an admission decision. Carry it through initialization so a
  // mutable registry cannot silently downgrade an admitted assigned-VM session to local execution.
  const executionOwnerAgentId =
    params.executionOwnerAgentId &&
    params.targetAgentId &&
    canUseAcpProcessTransport({
      executionOwnerAgentId: params.executionOwnerAgentId,
      agent: params.targetAgentId,
    })
      ? params.executionOwnerAgentId
      : undefined;
  if (
    (requesterSandboxed || sandboxMode === "require") &&
    backend?.isolatesSandboxedRequesters?.() === true &&
    executionOwnerAgentId
  ) {
    return { ok: true, executionOwnerAgentId };
  }
  const error = resolveSpawnSandboxError({
    backend: "acp",
    requesterSandboxed,
    sandbox: sandboxMode,
  });
  return error
    ? { ok: false, error }
    : {
        ok: true,
        ...(executionOwnerAgentId ? { executionOwnerAgentId } : {}),
      };
}
