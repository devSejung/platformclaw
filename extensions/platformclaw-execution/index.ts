import { registerAcpProcessTransport } from "openclaw/plugin-sdk/acp-runtime-backend";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { PLATFORMCLAW_VM_ACP_AGENTS } from "./src/acp-process-transport.js";
import {
  createPlatformClawExecutionBackendFactory,
  createPlatformClawExecutionSkillProvider,
  createPlatformClawExecutionSkillInstallProvider,
  createPlatformClawExecutionSkillWorkshopProvider,
  createPlatformClawExecutionTerminalProvider,
  createUnavailableExecutionDependencies,
  PLATFORMCLAW_EXECUTION_BACKEND_ID,
} from "./src/backend.js";
import type { AssignedVmTargetSnapshot } from "./src/backend.js";
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
    const targetMutations = new PlatformClawTargetMutationCoordinator();
    const preparedAcpTargets = new Map<string, Readonly<AssignedVmTargetSnapshot>>();
    const activeAcpChildren = new Map<string, Set<import("node:child_process").ChildProcess>>();
    const normalizeAgentId = (agentId: string) => agentId.trim().toLowerCase();
    const acpTargetKey = (agentId: string, sessionKey: string) =>
      `${normalizeAgentId(agentId)}\0${sessionKey.trim()}`;
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
    const unregisterAcpTransport = executionRuntimePromise
      ? registerAcpProcessTransport({
          id: "platformclaw-assigned-vm",
          isolatesSandboxedRequesters: true,
          supports: ({ agent }) => PLATFORMCLAW_VM_ACP_AGENTS.has(agent.trim().toLowerCase()),
          async prepare({ executionOwnerAgentId, sessionKey }) {
            const target = await (
              await dependenciesPromise
            ).resolveTarget({
              agentId: executionOwnerAgentId,
              target: "assigned_vm",
            });
            if (target.kind !== "assigned_vm") {
              throw new Error("ACP requires an assigned development VM.");
            }
            const key = acpTargetKey(executionOwnerAgentId, sessionKey);
            const existing = preparedAcpTargets.get(key);
            if (
              existing &&
              (existing.allocationId !== target.allocationId ||
                existing.revision !== target.revision ||
                existing.credentialRevision !== target.credentialRevision)
            ) {
              throw new Error("Assigned VM ACP target changed; close the ACP session and retry.");
            }
            preparedAcpTargets.set(key, target);
            return { cwd: target.remoteWorkspaceDir };
          },
          async launch(input) {
            const key = acpTargetKey(input.executionOwnerAgentId, input.sessionKey);
            const prepared = preparedAcpTargets.get(key);
            if (!prepared || prepared.agentId !== input.executionOwnerAgentId) {
              throw new Error("Assigned VM ACP target was not prepared for this session.");
            }
            const current = await (
              await dependenciesPromise
            ).resolveTarget({
              agentId: input.executionOwnerAgentId,
              target: "assigned_vm",
            });
            if (
              current.kind !== "assigned_vm" ||
              current.allocationId !== prepared.allocationId ||
              current.revision !== prepared.revision ||
              current.credentialRevision !== prepared.credentialRevision
            ) {
              preparedAcpTargets.delete(key);
              throw new Error("Assigned VM ACP target changed; close the ACP session and retry.");
            }
            const owner = normalizeAgentId(input.executionOwnerAgentId);
            const active = activeAcpChildren.get(owner) ?? new Set();
            if (active.size >= 3) {
              throw new Error(
                "Assigned VM ACP session limit reached (3); close a session and retry.",
              );
            }
            const child = await (await dependenciesPromise).launchAcpProcess(input, prepared);
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
        })
      : () => {};
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
    if (!executionRuntimePromise) {
      return;
    }
    const disposeSkillExports = registerPlatformClawExecutionGateway(
      api,
      executionRuntimePromise,
      targetMutations,
      invalidateAcpProcesses,
    );
    api.on("gateway_stop", async () => {
      unregisterAcpTransport();
      for (const agentId of activeAcpChildren.keys()) {
        invalidateAcpProcesses(agentId);
      }
      preparedAcpTargets.clear();
      await disposeSkillExports();
      await (await executionRuntimePromise).dispose();
    });
  },
});
