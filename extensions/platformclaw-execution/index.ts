import {
  AcpProcessTransportError,
  registerAcpProcessTransport,
  type AcpProcessTransportDiagnostic,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { PLATFORMCLAW_VM_ACP_AGENTS } from "./src/acp-process-command.js";
import {
  createPlatformClawExecutionBackendFactory,
  createPlatformClawExecutionSkillProvider,
  createPlatformClawExecutionSkillInstallProvider,
  createPlatformClawExecutionSkillWorkshopProvider,
  createPlatformClawExecutionTerminalProvider,
  createUnavailableExecutionDependencies,
  PLATFORMCLAW_EXECUTION_BACKEND_ID,
} from "./src/backend.js";
import type {
  AssignedVmTargetSnapshot,
  PlatformClawExecutionTargetSnapshot,
} from "./src/backend.js";
import { registerPlatformClawExecutionGateway } from "./src/gateway.js";
import { createExecutionDependenciesFromEnvironment } from "./src/runtime.js";
import { PlatformClawTargetMutationCoordinator } from "./src/target-mutation-coordinator.js";

export default definePluginEntry({
  id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
  name: "PlatformClaw Execution",
  description: "Private execution-target router for PlatformClaw personal agents.",
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const configured =
      process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS &&
      process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE;
    const logTiming = (message: string) => api.logger.info(message);
    const executionRuntimePromise = configured
      ? createExecutionDependenciesFromEnvironment(process.env, { logTiming })
      : undefined;
    const dependenciesPromise =
      executionRuntimePromise ?? Promise.resolve(createUnavailableExecutionDependencies());
    const requireExecutionRuntime = async () => {
      if (!executionRuntimePromise) {
        throw new Error(
          "Assigned VM ACP routing is not configured; configure the PlatformClaw credential broker and execution service token, then restart the Gateway.",
        );
      }
      return await executionRuntimePromise;
    };
    const targetMutations = new PlatformClawTargetMutationCoordinator();
    const preparedAcpTargets = new Map<string, Readonly<AssignedVmTargetSnapshot>>();
    const activeAcpChildren = new Map<string, Set<import("node:child_process").ChildProcess>>();
    const normalizeAgentId = (agentId: string) => agentId.trim().toLowerCase();
    const acpTargetKey = (agentId: string, sessionKey: string) =>
      `${normalizeAgentId(agentId)}\0${sessionKey.trim()}`;
    const stageError = (diagnostic: Omit<AcpProcessTransportDiagnostic, "ok">, cause: unknown) =>
      new AcpProcessTransportError(diagnostic, {
        cause: cause instanceof Error ? cause : undefined,
      });
    const invalidateAcpProcesses = (agentId: string) => {
      const owner = normalizeAgentId(agentId);
      const children = activeAcpChildren.get(owner);
      activeAcpChildren.delete(owner);
      for (const child of children ?? []) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
      }
      for (const key of preparedAcpTargets.keys()) {
        if (key.startsWith(`${owner}\0`)) {
          preparedAcpTargets.delete(key);
        }
      }
    };
    // Claim PlatformClaw's VM agents even when server credentials are incomplete.
    // Otherwise ACPX can silently launch the adapter on the Gateway host.
    const unregisterAcpTransport = registerAcpProcessTransport({
      id: "platformclaw-assigned-vm",
      isolatesSandboxedRequesters: true,
      supports: ({ agent }) => PLATFORMCLAW_VM_ACP_AGENTS.has(agent.trim().toLowerCase()),
      async prepare({ executionOwnerAgentId, sessionKey }) {
        if (!executionRuntimePromise) {
          throw stageError(
            {
              stage: "routing",
              code: "routing_not_configured",
              message:
                "Assigned VM ACP routing is not configured; configure the PlatformClaw credential broker and execution service token, then restart the Gateway.",
            },
            undefined,
          );
        }
        let target: PlatformClawExecutionTargetSnapshot;
        try {
          target = await (
            await requireExecutionRuntime()
          ).resolveTarget({
            agentId: executionOwnerAgentId,
            target: "assigned_vm",
          });
        } catch (error) {
          throw stageError(
            {
              stage: "target",
              code: "target_prepare_failed",
              message:
                "Assigned VM ACP target could not be prepared. Verify the personal VM assignment and Gateway execution service, then retry.",
              retryable: true,
            },
            error,
          );
        }
        if (target.kind !== "assigned_vm") {
          throw stageError(
            {
              stage: "target",
              code: "target_not_assigned_vm",
              message: "ACP requires an assigned development VM.",
            },
            undefined,
          );
        }
        const key = acpTargetKey(executionOwnerAgentId, sessionKey);
        const existing = preparedAcpTargets.get(key);
        if (
          existing &&
          (existing.allocationId !== target.allocationId ||
            existing.revision !== target.revision ||
            existing.credentialRevision !== target.credentialRevision)
        ) {
          throw stageError(
            {
              stage: "target",
              code: "target_changed",
              message: "Assigned VM ACP target changed. Close the ACP session and retry.",
              retryable: true,
            },
            undefined,
          );
        }
        preparedAcpTargets.set(key, target);
        return { cwd: target.remoteWorkspaceDir };
      },
      async diagnose({ executionOwnerAgentId, agent, signal }) {
        if (!executionRuntimePromise) {
          return {
            ok: false,
            stage: "routing",
            code: "routing_not_configured",
            message:
              "Assigned VM ACP routing is not configured; configure the PlatformClaw credential broker and execution service token, then restart the Gateway.",
          };
        }
        let executionRuntime: Awaited<ReturnType<typeof requireExecutionRuntime>>;
        let target: PlatformClawExecutionTargetSnapshot;
        try {
          executionRuntime = await requireExecutionRuntime();
          target = await executionRuntime.resolveTarget({
            agentId: executionOwnerAgentId,
            target: "assigned_vm",
          });
        } catch {
          return {
            ok: false,
            stage: "target",
            code: "target_prepare_failed",
            message:
              "Assigned VM ACP target could not be prepared. Verify the personal VM assignment and Gateway execution service, then retry.",
            retryable: true,
          };
        }
        if (target.kind !== "assigned_vm") {
          return {
            ok: false,
            stage: "target",
            code: "target_not_assigned_vm",
            message: "ACP requires an assigned development VM.",
          };
        }
        const report = await executionRuntime.diagnoseAcpProcess(agent, target, signal);
        if (!report.ok) {
          return report;
        }
        let current;
        try {
          current = await executionRuntime.resolveTarget({
            agentId: executionOwnerAgentId,
            target: "assigned_vm",
          });
        } catch {
          return {
            ok: false,
            stage: "target",
            code: "target_revalidation_failed",
            message: "Assigned VM ACP target could not be revalidated. Retry the diagnostic.",
            retryable: true,
          };
        }
        if (
          current.kind !== "assigned_vm" ||
          current.allocationId !== target.allocationId ||
          current.revision !== target.revision ||
          current.credentialRevision !== target.credentialRevision
        ) {
          return {
            ok: false,
            stage: "target",
            code: "target_changed",
            message: "Assigned VM ACP target changed during the diagnostic. Retry the diagnostic.",
            retryable: true,
          };
        }
        return report;
      },
      async launch(input) {
        const key = acpTargetKey(input.executionOwnerAgentId, input.sessionKey);
        const prepared = preparedAcpTargets.get(key);
        if (!prepared || prepared.agentId !== input.executionOwnerAgentId) {
          throw stageError(
            {
              stage: "target",
              code: "target_not_prepared",
              message: "Assigned VM ACP target was not prepared. Close the ACP session and retry.",
              retryable: true,
            },
            undefined,
          );
        }
        const executionRuntime = await requireExecutionRuntime();
        let current;
        try {
          current = await executionRuntime.resolveTarget({
            agentId: input.executionOwnerAgentId,
            target: "assigned_vm",
          });
        } catch (error) {
          throw stageError(
            {
              stage: "target",
              code: "target_revalidation_failed",
              message:
                "Assigned VM ACP target could not be revalidated. Close the ACP session and retry.",
              retryable: true,
            },
            error,
          );
        }
        if (
          current.kind !== "assigned_vm" ||
          current.allocationId !== prepared.allocationId ||
          current.revision !== prepared.revision ||
          current.credentialRevision !== prepared.credentialRevision
        ) {
          preparedAcpTargets.delete(key);
          throw stageError(
            {
              stage: "target",
              code: "target_changed",
              message: "Assigned VM ACP target changed. Close the ACP session and retry.",
              retryable: true,
            },
            undefined,
          );
        }
        const owner = normalizeAgentId(input.executionOwnerAgentId);
        const active = activeAcpChildren.get(owner) ?? new Set();
        if (active.size >= 3) {
          throw stageError(
            {
              stage: "routing",
              code: "session_limit_reached",
              message: "Assigned VM ACP session limit reached (3). Close a session and retry.",
              retryable: true,
            },
            undefined,
          );
        }
        const child = await executionRuntime.launchAcpProcess(input, prepared);
        active.add(child);
        activeAcpChildren.set(owner, active);
        child.once("close", () => {
          active.delete(child);
          if (active.size === 0) {
            activeAcpChildren.delete(owner);
          }
        });
        return child;
      },
      release({ executionOwnerAgentId, sessionKey }) {
        preparedAcpTargets.delete(acpTargetKey(executionOwnerAgentId, sessionKey));
      },
    });
    registerSandboxBackend(PLATFORMCLAW_EXECUTION_BACKEND_ID, {
      factory: async (params) =>
        await createPlatformClawExecutionBackendFactory(await dependenciesPromise, {
          logTiming,
        })(params),
      skillMaterialization: "backend-deferred",
      skills: async (params) =>
        await createPlatformClawExecutionSkillProvider(await dependenciesPromise)(params),
      skillInstall: async (params) =>
        await createPlatformClawExecutionSkillInstallProvider(
          await dependenciesPromise,
          targetMutations,
        )(params),
      skillWorkshop: async (params) =>
        await createPlatformClawExecutionSkillWorkshopProvider(await dependenciesPromise)(params),
      terminal: async (params) =>
        await createPlatformClawExecutionTerminalProvider(
          await dependenciesPromise,
          targetMutations,
        )(params),
    });
    const disposeSkillExports = executionRuntimePromise
      ? registerPlatformClawExecutionGateway(
          api,
          executionRuntimePromise,
          targetMutations,
          invalidateAcpProcesses,
        )
      : undefined;
    api.on("gateway_stop", async () => {
      unregisterAcpTransport();
      for (const agentId of activeAcpChildren.keys()) {
        invalidateAcpProcesses(agentId);
      }
      preparedAcpTargets.clear();
      await disposeSkillExports?.();
      await (await executionRuntimePromise)?.dispose();
    });
  },
});
