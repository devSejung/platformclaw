import {
  getSandboxBackendFactory,
  registerSandboxBackend,
  type SandboxBackendHandle,
} from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
  createPlatformClawExecutionBackendFactory,
  PLATFORMCLAW_EXECUTION_BACKEND_ID,
  type PlatformClawExecutionDependencies,
  type PlatformClawExecutionTargetSnapshot,
} from "../extensions/platformclaw-execution/src/backend.js";
import { resolveSandboxConfigForAgent } from "../src/agents/sandbox/config.js";
import { buildCronAgentDefaultsConfig } from "../src/cron/isolated-agent/run-config.js";
import { CronService } from "../src/cron/service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "../src/cron/service.test-harness.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "platformclaw-cron-execution-" });
installCronTestHooks({ logger });

function handle(runtimeId: string, prefixArgv: string[]): SandboxBackendHandle {
  return {
    id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
    runtimeId,
    runtimeLabel: runtimeId,
    workdir: `/${runtimeId}`,
    buildExecSpec: async ({ command, env }) => ({
      argv: [...prefixArgv, command],
      env,
      stdinMode: "pipe-closed",
    }),
    runShellCommand: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }),
  };
}

function cronSandboxConfig(agentId: string) {
  const defaults = buildCronAgentDefaultsConfig({
    defaults: {
      sandbox: {
        mode: "all",
        backend: PLATFORMCLAW_EXECUTION_BACKEND_ID,
        scope: "session",
        workspaceAccess: "rw",
        prune: { idleHours: 0, maxAgeDays: 0 },
      },
    },
  });
  return resolveSandboxConfigForAgent({ agents: { defaults, list: [{ id: agentId }] } }, agentId);
}

const targets: PlatformClawExecutionTargetSnapshot[] = [
  {
    kind: "platform_server",
    agentId: "employee",
    revision: 1,
    targetId: "server-default",
  },
  {
    kind: "assigned_vm",
    agentId: "employee",
    revision: 2,
    targetId: "vm-one",
    allocationId: "allocation-one",
    credentialRevision: 3,
    vmLabel: "Development VM",
    safeConnectLabel: "Corporate access",
    remoteHomeDir: "/home/employee",
    remoteWorkspaceDir: "/home/employee/workspace",
    endpointHost: "safeconnect.example",
    endpointPort: 22,
    adDomain: "example",
    adAccount: "employee",
    targetAddress: "192.0.2.10",
    linuxAccount: "employee",
    hostKeyAlgorithm: "ssh-ed25519",
    hostKeyPublicKey: "AAAA-test",
    hostKeyFingerprint: "SHA256:test",
  },
];

describe("PlatformClaw scheduled agent execution", () => {
  it.each(targets)(
    "forces a persisted cron agent turn through $kind without a VM OpenClaw CLI",
    async (target) => {
      const dependencies: PlatformClawExecutionDependencies = {
        resolveTarget: vi.fn(async () => target),
        createPlatformServerHandle: vi.fn(async () =>
          handle("platform-server", ["docker", "exec", "sandbox", "sh"]),
        ),
        createAssignedVmHandle: vi.fn(async () =>
          handle("assigned-vm", ["ssh", "platformclaw-safeconnect", "--", "sh"]),
        ),
        listTargetSkills: vi.fn(async () => undefined),
        createSkillWorkshopTarget: vi.fn(async () => undefined),
        createSkillInstallTarget: vi.fn(async () => undefined),
      };
      const restore = registerSandboxBackend(
        PLATFORMCLAW_EXECUTION_BACKEND_ID,
        createPlatformClawExecutionBackendFactory(dependencies),
      );
      const { storePath } = await makeStorePath();
      const writer = new CronService({
        storePath,
        cronEnabled: true,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: async () => {
          throw new Error("writer must not execute the persisted job");
        },
      });
      await writer.start();
      const job = await writer.add({
        name: `${target.kind} scheduled turn`,
        agentId: target.agentId,
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "prepare the scheduled report" },
        delivery: { mode: "none" },
      });
      writer.stop();

      const executedArgv: string[][] = [];
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: async ({ job }) => {
          const cfg = cronSandboxConfig(job.agentId ?? target.agentId);
          const factory = getSandboxBackendFactory(cfg.backend);
          if (!factory) {
            throw new Error("PlatformClaw execution backend was not registered");
          }
          const backend = await factory({
            agentId: job.agentId,
            sessionKey: `agent:${job.agentId}:cron:${job.id}`,
            scopeKey: `agent:${job.agentId}:cron:${job.id}`,
            workspaceDir: `/workspace/${job.agentId}`,
            agentWorkspaceDir: `/agents/${job.agentId}`,
            materializeSkills: async () => undefined,
            cfg,
          });
          const spec = await backend.buildExecSpec({
            command: "printf ready",
            env: {},
            usePty: false,
          });
          executedArgv.push(spec.argv);
          return { status: "ok" as const, summary: "ready" };
        },
      });
      try {
        await cron.start();
        expect(await cron.run(job.id, "force")).toMatchObject({ ok: true, ran: true });

        expect(dependencies.resolveTarget).toHaveBeenCalledWith({ agentId: target.agentId });
        expect(dependencies.createPlatformServerHandle).toHaveBeenCalledTimes(
          target.kind === "platform_server" ? 1 : 0,
        );
        expect(dependencies.createAssignedVmHandle).toHaveBeenCalledTimes(
          target.kind === "assigned_vm" ? 1 : 0,
        );
        expect(executedArgv).toHaveLength(1);
        expect(executedArgv[0]?.join(" ")).not.toMatch(/\bopenclaw\b/u);
      } finally {
        cron.stop();
        restore();
      }
    },
  );
});
