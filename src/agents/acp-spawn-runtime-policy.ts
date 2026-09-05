import { canUseAcpProcessTransport } from "../acp/runtime/process-transport.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { resolveSpawnSandboxError } from "./spawn-plan.js";

export function resolveAcpSpawnRuntimePolicyError(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  requesterSandboxed?: boolean;
  sandbox?: "inherit" | "require";
  executionOwnerAgentId?: string;
  targetAgentId?: string;
}): string | undefined {
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterSessionKey,
  });
  const requesterSandboxed = params.requesterSandboxed === true || requesterRuntime.sandboxed;
  const backend = getAcpRuntimeBackend(params.cfg.acp?.backend);
  if (
    (requesterSandboxed || sandboxMode === "require") &&
    backend?.isolatesSandboxedRequesters?.() === true &&
    params.executionOwnerAgentId &&
    params.targetAgentId &&
    canUseAcpProcessTransport({
      executionOwnerAgentId: params.executionOwnerAgentId,
      agent: params.targetAgentId,
    })
  ) {
    return undefined;
  }
  return resolveSpawnSandboxError({
    backend: "acp",
    requesterSandboxed,
    sandbox: sandboxMode,
  });
}
