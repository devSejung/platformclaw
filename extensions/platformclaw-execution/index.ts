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
import { registerPlatformClawCredentialTool } from "./src/credential-tool.js";
import { registerPlatformClawExecutionGateway } from "./src/gateway.js";
import { createExecutionDependenciesFromEnvironment } from "./src/runtime.js";
import { PlatformClawTargetMutationCoordinator } from "./src/target-mutation-coordinator.js";

export default definePluginEntry({
  id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
  name: "PlatformClaw Execution",
  description: "Private execution-target router for PlatformClaw personal agents.",
  register(api) {
    const configured =
      process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS &&
      process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE;
    const logTiming = (message: string) => api.logger.info(message);
    const targetMutations = new PlatformClawTargetMutationCoordinator();
    let runtimePromise: ReturnType<typeof createExecutionDependenciesFromEnvironment> | undefined;
    const getExecutionRuntime = () =>
      (runtimePromise ??= createExecutionDependenciesFromEnvironment(process.env, {
        logTiming,
        targetMutations,
      }));
    registerPlatformClawCredentialTool(api, configured ? getExecutionRuntime : undefined);
    if (api.registrationMode !== "full") {
      return;
    }
    const executionRuntimePromise = configured ? getExecutionRuntime() : undefined;
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
    const preparedAcpTargets = new Map<
      string,
      { target: Readonly<AssignedVmTargetSnapshot>; controller: AbortController }
    >();
    const activeAcpChildren = new Map<string, Set<import("node:child_process").ChildProcess>>();
    const pendingAcpLaunches = new Map<string, number>();
    const acpAuthorities = new Map<string, AbortController>();
    let stopping = false;
    const normalizeAgentId = (agentId: string) => agentId.trim().toLowerCase();
    const acpTargetKey = (agentId: string, sessionKey: string) =>
      `${normalizeAgentId(agentId)}\0${sessionKey.trim()}`;
    const stageError = (diagnostic: Omit<AcpProcessTransportDiagnostic, "ok">, cause: unknown) =>
      new AcpProcessTransportError(diagnostic, {
        cause: cause instanceof Error ? cause : undefined,
      });
    const captureAcpAuthority = (agentId: string) => {
      const owner = normalizeAgentId(agentId);
      const authority = acpAuthorities.get(owner) ?? new AbortController();
      if (!stopping) {
        acpAuthorities.set(owner, authority);
      }
      return { owner, authority };
    };
    const assertAcpAuthority = ({ owner, authority }: ReturnType<typeof captureAcpAuthority>) => {
      // Status/control calls can warm an ACP handle without starting a turn.
      // They must not create an SSH lease while a target switch owns admission.
      if (
        stopping ||
        targetMutations.isHeld(owner, "target-change") ||
        authority.signal.aborted ||
        acpAuthorities.get(owner) !== authority
      ) {
        throw stageError(
          {
            stage: "target",
            code: "target_changed",
            message: "Assigned VM ACP authority changed. Close the ACP session and retry.",
            retryable: true,
          },
          undefined,
        );
      }
    };
    const requireEnabledAgent = (target: AssignedVmTargetSnapshot, agent: string) => {
      const configuration = target.codingAgents.find((entry) => entry.agent === agent);
      if (!configuration?.enabled) {
        throw stageError(
          {
            stage: "routing",
            code: "agent_disabled",
            message: `${agent} is disabled for this personal coding agent. Enable it in Coding agents settings and retry.`,
          },
          undefined,
        );
      }
    };
    const invalidateAcpProcesses = (agentId: string) => {
      const owner = normalizeAgentId(agentId);
      acpAuthorities.get(owner)?.abort();
      acpAuthorities.delete(owner);
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
      maxConcurrentSessions: 5,
      supports: ({ agent }) => PLATFORMCLAW_VM_ACP_AGENTS.has(agent.trim().toLowerCase()),
      async prepare({ executionOwnerAgentId, sessionKey, agent }) {
        const authority = captureAcpAuthority(executionOwnerAgentId);
        assertAcpAuthority(authority);
        const key = acpTargetKey(executionOwnerAgentId, sessionKey);
        const admitted = preparedAcpTargets.get(key);
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
          const executionRuntime = await requireExecutionRuntime();
          assertAcpAuthority(authority);
          target = await executionRuntime.resolveTarget({
            agentId: executionOwnerAgentId,
            target: "assigned_vm",
          });
        } catch (error) {
          assertAcpAuthority(authority);
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
        // Invalidation may finish while the broker lookup is pending. That old
        // admission must never repopulate the prepared-target cache.
        assertAcpAuthority(authority);
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
        requireEnabledAgent(target, agent.trim().toLowerCase());
        const existing = preparedAcpTargets.get(key);
        if (
          (admitted && admitted !== existing) ||
          (existing &&
            (existing.target.allocationId !== target.allocationId ||
              existing.target.revision !== target.revision ||
              existing.target.credentialRevision !== target.credentialRevision))
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
        if (existing) {
          // Re-ensuring the same session retains its lifetime and live children.
          existing.target = target;
        } else {
          preparedAcpTargets.set(key, { target, controller: new AbortController() });
        }
        return { cwd: target.remoteWorkspaceDir };
      },
      async diagnose({ executionOwnerAgentId, agent, signal }) {
        const authority = captureAcpAuthority(executionOwnerAgentId);
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
          assertAcpAuthority(authority);
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
        const currentSignal = signal
          ? AbortSignal.any([signal, authority.authority.signal])
          : authority.authority.signal;
        if (stopping || currentSignal.aborted) {
          return {
            ok: false,
            stage: "target",
            code: "target_changed",
            message: "Assigned VM ACP authority changed. Retry the diagnostic.",
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
        if (!target.codingAgents.find((entry) => entry.agent === agent)?.enabled) {
          return {
            ok: false,
            stage: "routing",
            code: "agent_disabled",
            message: `${agent} is disabled for this personal coding agent. Enable it in Coding agents settings and retry.`,
          };
        }
        const report = await executionRuntime.diagnoseAcpProcess(agent, target, currentSignal);
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
          stopping ||
          currentSignal.aborted ||
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
        const authority = captureAcpAuthority(input.executionOwnerAgentId);
        assertAcpAuthority(authority);
        const key = acpTargetKey(input.executionOwnerAgentId, input.sessionKey);
        const prepared = preparedAcpTargets.get(key);
        if (!prepared || prepared.target.agentId !== input.executionOwnerAgentId) {
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
        const preparedTarget = prepared.target;
        const launchSignal = AbortSignal.any([
          authority.authority.signal,
          prepared.controller.signal,
        ]);
        const executionRuntime = await requireExecutionRuntime();
        assertAcpAuthority(authority);
        let current;
        try {
          current = await executionRuntime.resolveTarget({
            agentId: input.executionOwnerAgentId,
            target: "assigned_vm",
          });
        } catch (error) {
          assertAcpAuthority(authority);
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
        assertAcpAuthority(authority);
        if (
          preparedAcpTargets.get(key) !== prepared ||
          current.kind !== "assigned_vm" ||
          current.allocationId !== preparedTarget.allocationId ||
          current.revision !== preparedTarget.revision ||
          current.credentialRevision !== preparedTarget.credentialRevision
        ) {
          if (preparedAcpTargets.get(key) === prepared) {
            preparedAcpTargets.delete(key);
          }
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
        requireEnabledAgent(current, input.agent.trim().toLowerCase());
        const owner = normalizeAgentId(input.executionOwnerAgentId);
        const active = activeAcpChildren.get(owner) ?? new Set();
        const pending = pendingAcpLaunches.get(owner) ?? 0;
        if (active.size + pending >= 5) {
          throw stageError(
            {
              stage: "routing",
              code: "session_limit_reached",
              message:
                "Assigned VM ACP capacity reached (5). Wait for work to finish or explicitly close an unused session and retry.",
              retryable: true,
            },
            undefined,
          );
        }
        // Reserve synchronously so concurrent harness launches cannot oversubscribe an owner.
        activeAcpChildren.set(owner, active);
        pendingAcpLaunches.set(owner, pending + 1);
        let child: Awaited<ReturnType<typeof executionRuntime.launchAcpProcess>>;
        try {
          child = await executionRuntime.launchAcpProcess(input, preparedTarget, launchSignal);
        } finally {
          const remaining = (pendingAcpLaunches.get(owner) ?? 1) - 1;
          if (remaining > 0) {
            pendingAcpLaunches.set(owner, remaining);
          } else {
            pendingAcpLaunches.delete(owner);
            if (active.size === 0 && activeAcpChildren.get(owner) === active) {
              activeAcpChildren.delete(owner);
            }
          }
        }
        if (stopping || launchSignal.aborted || preparedAcpTargets.get(key) !== prepared) {
          child.kill("SIGTERM");
          assertAcpAuthority(authority);
          throw stageError(
            {
              stage: "target",
              code: "target_changed",
              message: "Assigned VM ACP target changed during process launch. Close and retry.",
              retryable: true,
            },
            undefined,
          );
        }
        active.add(child);
        activeAcpChildren.set(owner, active);
        child.once("close", () => {
          active.delete(child);
          if (active.size === 0 && activeAcpChildren.get(owner) === active) {
            activeAcpChildren.delete(owner);
          }
        });
        return child;
      },
      release({ executionOwnerAgentId, sessionKey }) {
        const key = acpTargetKey(executionOwnerAgentId, sessionKey);
        const prepared = preparedAcpTargets.get(key);
        preparedAcpTargets.delete(key);
        // ACPX may release after its close timeout while a custom process
        // launcher is still awaiting SSH. Retire that exact session admission.
        prepared?.controller.abort();
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
      stopping = true;
      unregisterAcpTransport();
      for (const agentId of acpAuthorities.keys()) {
        invalidateAcpProcesses(agentId);
      }
      preparedAcpTargets.clear();
      await disposeSkillExports?.();
      await (await executionRuntimePromise)?.dispose();
    });
  },
});
