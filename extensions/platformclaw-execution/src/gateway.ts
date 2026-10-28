import {
  isCodingAgentId,
  parseCodingAgentConfiguration,
  type CodingAgentConfiguration,
  type CodingAgentId,
  type CodingAgentVmProbeResult,
} from "@platformclaw/coding-agent-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PlatformClawExecutionTargetSnapshot } from "./backend.js";
import { classifyVmConnectionFailure } from "./connection-errors.js";
import {
  registerPlatformClawSkillExportGateway,
  type PlatformClawSkillExportRuntime,
} from "./skill-export-gateway.js";
import {
  PlatformClawTargetChangeError,
  type PlatformClawTargetMutationCoordinator,
} from "./target-mutation-coordinator.js";

type PlatformClawExecutionGatewayRuntime = PlatformClawSkillExportRuntime & {
  testConnection(params: {
    agentId: string;
    credentialBrokerAddress: string;
    credentialGrantToken: string;
  }): Promise<{
    allocationId: string;
    targetRevision: number;
    remoteHomeDir: string;
    remoteWorkspaceDir: string;
  }>;
  testCandidateConnection(params: {
    target: unknown;
    credentialBrokerAddress: string;
    credentialGrantToken: string;
  }): Promise<{
    allocationId: string;
    targetRevision: number;
    remoteHomeDir: string;
    remoteWorkspaceDir: string;
  }>;
  changeTarget(params: {
    agentId: string;
    target: "platform_server" | "assigned_vm";
    expectedRevision: number;
    connectionId?: string;
    expectedConnectionRevision?: number;
  }): Promise<PlatformClawExecutionTargetSnapshot>;
  detectCodingAgent(params: {
    agentId: string;
    agent: CodingAgentId;
    expectedRevision: number;
  }): Promise<CodingAgentVmProbeResult>;
  checkCodingAgent(params: {
    agentId: string;
    configuration: CodingAgentConfiguration;
    expectedRevision: number;
  }): Promise<CodingAgentVmProbeResult>;
  dispose(): Promise<void>;
};

export function registerPlatformClawExecutionGateway(
  api: Pick<OpenClawPluginApi, "logger" | "on" | "registerGatewayMethod">,
  runtimePromise: Promise<PlatformClawExecutionGatewayRuntime>,
  targetMutations: PlatformClawTargetMutationCoordinator,
  invalidateAcpProcesses: (agentId: string) => void,
): () => Promise<void> {
  const tryAcquireTargetChange = (
    agentId: string,
    context: { tryAcquireAgentWorkMutation(agentId: string): (() => void) | null },
  ) => {
    const releaseWorkspace = targetMutations.tryAcquire(agentId, "target-change");
    if (!releaseWorkspace) {
      return null;
    }
    // The host admission fence covers cron, queued preparation and warm ACP turns;
    // the plugin coordinator also owns foreground workspace mutations.
    const releaseAgentWork = context.tryAcquireAgentWorkMutation(agentId);
    if (!releaseAgentWork) {
      releaseWorkspace();
      return null;
    }
    return () => {
      releaseAgentWork();
      releaseWorkspace();
    };
  };
  const disposeSkillExports = registerPlatformClawSkillExportGateway(
    api,
    runtimePromise,
    targetMutations,
  );
  api.on("before_agent_run", (_event, context) => {
    const agentId = context.agentId?.trim();
    return agentId && targetMutations.isHeld(agentId, "target-change")
      ? {
          outcome: "block",
          reason: "execution target change is in progress",
          message: "Your work location is changing. Try again in a moment.",
        }
      : { outcome: "pass" };
  });
  for (const candidate of [false, true]) {
    const method = candidate ? "testCandidateConnection" : "testConnection";
    api.registerGatewayMethod(
      `platformclaw-execution.${method}`,
      async ({ params, context, respond }) => {
        const input = params as Record<string, unknown>;
        const target = input.target;
        const owner = candidate
          ? target && typeof target === "object" && !Array.isArray(target)
            ? (target as Record<string, unknown>).agentId
            : undefined
          : input.agentId;
        const agentId = typeof owner === "string" ? owner.trim() : "";
        const credentialBrokerAddress =
          typeof input.credentialBrokerAddress === "string"
            ? input.credentialBrokerAddress.trim()
            : "";
        const credentialGrantToken =
          typeof input.credentialGrantToken === "string" ? input.credentialGrantToken.trim() : "";
        if (!agentId || !credentialBrokerAddress || !credentialGrantToken) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "connection test request is invalid",
          });
          return;
        }
        // Probes ensure the remote workspace exists. Share the target guard so
        // setup cannot race an Agent run, publication, or workspace mutation.
        const release = tryAcquireTargetChange(agentId, context);
        if (!release) {
          respond(false, undefined, {
            code: "CONFLICT",
            message:
              "finish active tasks and workspace operations before checking the VM connection",
          });
          return;
        }
        try {
          const runtime = await runtimePromise;
          if (context.hasPendingAgentWork(agentId)) {
            respond(false, undefined, {
              code: "CONFLICT",
              message: "finish or cancel active and queued tasks before checking the VM connection",
            });
            return;
          }
          const credentials = { credentialBrokerAddress, credentialGrantToken };
          respond(
            true,
            candidate
              ? await runtime.testCandidateConnection({ target, ...credentials })
              : await runtime.testConnection({ agentId, ...credentials }),
          );
        } catch (error) {
          const failure = classifyVmConnectionFailure(error);
          api.logger.warn?.(
            `[platformclaw-execution] VM connection test failed agent=${agentId} kind=${failure.kind} cause=${failure.diagnostic}`,
          );
          respond(false, undefined, {
            code: failure.code,
            message: failure.message,
            details: { kind: failure.kind },
          });
        } finally {
          release();
        }
      },
      { scope: "operator.admin" },
    );
  }
  api.registerGatewayMethod(
    "platformclaw-execution.detectCodingAgent",
    async ({ params, context, respond }) => {
      const input = params as Record<string, unknown>;
      const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
      const expectedRevision = input.expectedRevision;
      if (
        !agentId ||
        !isCodingAgentId(input.agent) ||
        !Number.isSafeInteger(expectedRevision) ||
        (expectedRevision as number) < 0
      ) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "coding agent detection request is invalid",
        });
        return;
      }
      const release = tryAcquireTargetChange(agentId, context);
      if (!release) {
        respond(false, undefined, {
          code: "CONFLICT",
          message: "finish active work before checking the coding agent",
        });
        return;
      }
      try {
        const runtime = await runtimePromise;
        if (context.hasPendingAgentWork(agentId)) {
          respond(false, undefined, {
            code: "CONFLICT",
            message: "finish active and queued tasks before checking the coding agent",
          });
          return;
        }
        respond(
          true,
          await runtime.detectCodingAgent({
            agentId,
            agent: input.agent,
            expectedRevision: expectedRevision as number,
          }),
        );
      } catch {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message:
            "Coding agent detection failed. Reload the settings and verify the VM connection.",
        });
      } finally {
        release();
      }
    },
    { scope: "operator.admin" },
  );
  api.registerGatewayMethod(
    "platformclaw-execution.checkCodingAgent",
    async ({ params, context, respond }) => {
      const input = params as Record<string, unknown>;
      const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
      const expectedRevision = input.expectedRevision;
      let configuration: CodingAgentConfiguration;
      try {
        configuration = parseCodingAgentConfiguration(input.configuration);
      } catch {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "coding agent check request is invalid",
        });
        return;
      }
      if (!agentId || !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "coding agent request is invalid",
        });
        return;
      }
      const release = tryAcquireTargetChange(agentId, context);
      if (!release) {
        respond(false, undefined, {
          code: "CONFLICT",
          message: "finish active work before checking the coding agent",
        });
        return;
      }
      try {
        const runtime = await runtimePromise;
        if (context.hasPendingAgentWork(agentId)) {
          respond(false, undefined, {
            code: "CONFLICT",
            message: "finish active and queued tasks before checking the coding agent",
          });
          return;
        }
        respond(
          true,
          await runtime.checkCodingAgent({
            agentId,
            configuration,
            expectedRevision: expectedRevision as number,
          }),
        );
      } catch {
        // Remote command errors can contain account environment or diagnostic output.
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message:
            "Coding agent check failed. Ask your administrator to check its installation and VM connection.",
        });
      } finally {
        release();
      }
    },
    { scope: "operator.admin" },
  );
  api.registerGatewayMethod(
    "platformclaw-execution.changeTarget",
    async ({ params, context, respond }) => {
      const input = params as Record<string, unknown>;
      const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
      const target = input.target;
      const expectedRevision = input.expectedRevision;
      const connectionId = input.connectionId;
      const expectedConnectionRevision = input.expectedConnectionRevision;
      if (
        !agentId ||
        (target !== "platform_server" && target !== "assigned_vm") ||
        typeof expectedRevision !== "number" ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        (connectionId === undefined && expectedConnectionRevision !== undefined) ||
        (connectionId !== undefined &&
          (target !== "assigned_vm" ||
            typeof connectionId !== "string" ||
            !connectionId.trim() ||
            connectionId.length > 128 ||
            typeof expectedConnectionRevision !== "number" ||
            !Number.isSafeInteger(expectedConnectionRevision) ||
            expectedConnectionRevision < 1))
      ) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "work location change request is invalid",
        });
        return;
      }
      const releaseMutation = tryAcquireTargetChange(agentId, context);
      if (!releaseMutation) {
        respond(false, undefined, {
          code: "CONFLICT",
          message: "finish active tasks and workspace operations before changing work location",
        });
        return;
      }
      try {
        const runtime = await runtimePromise;
        // Deferred turns retain their old execution intent after the active run
        // settles. Check both owners after readiness, immediately before mutation.
        if (context.hasPendingAgentWork(agentId)) {
          respond(false, undefined, {
            code: "CONFLICT",
            message: "finish or cancel active and queued tasks before changing work location",
          });
          return;
        }
        const changed = await runtime.changeTarget({
          agentId,
          target,
          expectedRevision,
          ...(typeof connectionId === "string" && typeof expectedConnectionRevision === "number"
            ? { connectionId: connectionId.trim(), expectedConnectionRevision }
            : {}),
        });
        invalidateAcpProcesses(agentId);
        respond(true, changed);
      } catch (error) {
        if (error instanceof PlatformClawTargetChangeError && error.targetChanged) {
          invalidateAcpProcesses(agentId);
        }
        const conflict = error instanceof Error && error.message.includes("(409)");
        respond(false, undefined, {
          code: conflict ? "CONFLICT" : "UNAVAILABLE",
          message: conflict
            ? "work location changed before the requested update"
            : "work location service is unavailable",
        });
      } finally {
        releaseMutation();
      }
    },
    { scope: "operator.admin" },
  );
  api.registerGatewayMethod(
    "platformclaw-execution.invalidateAgent",
    async ({ params, respond }) => {
      const input = params as Record<string, unknown>;
      const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
      if (!agentId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "agent id is required" });
        return;
      }
      invalidateAcpProcesses(agentId);
      respond(true, { invalidated: true });
    },
    { scope: "operator.admin" },
  );

  return disposeSkillExports;
}
