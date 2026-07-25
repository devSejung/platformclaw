import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PlatformClawExecutionTargetSnapshot } from "./backend.js";
import { PlatformClawVmAuthenticationError } from "./connection-errors.js";

export type PlatformClawExecutionGatewayRuntime = {
  testConnection(params: { agentId: string; credentialGrantToken: string }): Promise<{
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
};

export function registerPlatformClawExecutionGateway(
  api: Pick<OpenClawPluginApi, "logger" | "on" | "registerGatewayMethod">,
  runtimePromise: Promise<PlatformClawExecutionGatewayRuntime>,
): void {
  const changingAgents = new Set<string>();
  api.on("before_agent_run", (_event, context) => {
    const agentId = context.agentId?.trim();
    return agentId && changingAgents.has(agentId)
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
      const credentialGrantToken =
        typeof input.credentialGrantToken === "string" ? input.credentialGrantToken.trim() : "";
      if (!agentId || !credentialGrantToken) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "connection test request is invalid",
        });
        return;
      }
      try {
        const runtime = await runtimePromise;
        respond(true, await runtime.testConnection({ agentId, credentialGrantToken }));
      } catch (error) {
        if (error instanceof PlatformClawVmAuthenticationError) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "development VM authentication failed",
            details: { kind: "vm_authentication_failed" },
          });
          return;
        }
        const failure = error as { code?: unknown; exitCode?: unknown; name?: unknown };
        const message =
          error instanceof Error
            ? error.message.replaceAll(/[\r\n\t]+/g, " ").slice(0, 500)
            : "unknown";
        api.logger.warn?.(
          `platformclaw-execution: VM connection test failed name=${String(failure?.name ?? "unknown")} code=${String(failure?.code ?? "unknown")} exitCode=${String(failure?.exitCode ?? "unknown")} message=${message}`,
        );
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "development VM connection failed",
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
      if (changingAgents.has(agentId)) {
        respond(false, undefined, {
          code: "CONFLICT",
          message: "work location is already changing",
        });
        return;
      }
      changingAgents.add(agentId);
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
        changingAgents.delete(agentId);
      }
    },
    { scope: "operator.admin" },
  );
}
