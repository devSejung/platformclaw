import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PlatformClawExecutionTargetSnapshot } from "./backend.js";
import { classifyVmConnectionFailure } from "./connection-errors.js";
import {
  registerPlatformClawSkillExportGateway,
  type PlatformClawSkillExportRuntime,
} from "./skill-export-gateway.js";
import type { PlatformClawTargetMutationCoordinator } from "./target-mutation-coordinator.js";

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
  }): Promise<PlatformClawExecutionTargetSnapshot>;
  dispose(): Promise<void>;
};

export function registerPlatformClawExecutionGateway(
  api: Pick<OpenClawPluginApi, "logger" | "on" | "registerGatewayMethod">,
  runtimePromise: Promise<PlatformClawExecutionGatewayRuntime>,
  targetMutations: PlatformClawTargetMutationCoordinator,
): void {
  registerPlatformClawSkillExportGateway(api, runtimePromise, targetMutations);
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
  api.registerGatewayMethod(
    "platformclaw-execution.testConnection",
    async ({ params, respond }) => {
      const input = params as Record<string, unknown>;
      const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
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
      try {
        const runtime = await runtimePromise;
        respond(
          true,
          await runtime.testConnection({
            agentId,
            credentialBrokerAddress,
            credentialGrantToken,
          }),
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
      }
    },
    { scope: "operator.admin" },
  );
  api.registerGatewayMethod(
    "platformclaw-execution.testCandidateConnection",
    async ({ params, respond }) => {
      const input = params as Record<string, unknown>;
      const credentialBrokerAddress =
        typeof input.credentialBrokerAddress === "string"
          ? input.credentialBrokerAddress.trim()
          : "";
      const credentialGrantToken =
        typeof input.credentialGrantToken === "string" ? input.credentialGrantToken.trim() : "";
      if (!input.target || !credentialBrokerAddress || !credentialGrantToken) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "candidate connection test request is invalid",
        });
        return;
      }
      try {
        const runtime = await runtimePromise;
        respond(
          true,
          await runtime.testCandidateConnection({
            target: input.target,
            credentialBrokerAddress,
            credentialGrantToken,
          }),
        );
      } catch (error) {
        const failure = classifyVmConnectionFailure(error);
        api.logger.warn?.(
          `[platformclaw-execution] candidate VM connection test failed kind=${failure.kind} cause=${failure.diagnostic}`,
        );
        respond(false, undefined, {
          code: failure.code,
          message: failure.message,
          details: { kind: failure.kind },
        });
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
      if (
        !agentId ||
        (target !== "platform_server" && target !== "assigned_vm") ||
        typeof expectedRevision !== "number" ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0
      ) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "work location change request is invalid",
        });
        return;
      }
      const releaseMutation = targetMutations.tryAcquire(agentId, "target-change");
      if (!releaseMutation) {
        respond(false, undefined, {
          code: "CONFLICT",
          message: "work location or workspace skill mutation is already in progress",
        });
        return;
      }
      try {
        const active = [...context.chatAbortControllers.values()].some(
          (entry) => entry.agentId?.trim() === agentId,
        );
        if (active) {
          respond(false, undefined, {
            code: "CONFLICT",
            message: "finish the current task before changing work location",
          });
          return;
        }
        const runtime = await runtimePromise;
        respond(true, await runtime.changeTarget({ agentId, target, expectedRevision }));
      } catch (error) {
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
}
