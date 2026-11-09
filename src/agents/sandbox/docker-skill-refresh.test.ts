import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAgentWorkAdmission } from "../agent-work-admission.js";
import { ensureSandboxContainer } from "./docker.js";
import { collectDockerFlagValues } from "./test-args.js";
import type { SandboxConfig } from "./types.js";

const { spawnState, registryMocks } = vi.hoisted(() => ({
  spawnState: {
    calls: [] as Array<{ args: string[] }>,
    containerExists: false,
    inspectRunning: false,
    labelHash: "",
    inspectManagedBinds: "",
    activeProcessSessions: [] as Array<{ sessionKey: string }>,
  },
  registryMocks: {
    readRegistryEntry: vi.fn(),
    removeRegistryEntry: vi.fn(),
    updateRegistry: vi.fn(),
  },
}));

vi.mock("./registry.js", () => registryMocks);
vi.mock("../bash-process-registry.js", () => ({
  listRunningSessions: () => spawnState.activeProcessSessions,
}));
vi.mock("./container-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./container-engine.js")>()),
  ensureContainerImage: vi.fn(),
  execContainer: vi.fn(async (_engine: unknown, args: string[]) => {
    spawnState.calls.push({ args });
    let stdout = "";
    let code = 0;
    if (args[0] === "inspect" && args[1] === "--type=container") {
      stdout = spawnState.inspectManagedBinds;
    } else if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
      code = spawnState.containerExists ? 0 : 1;
      stdout = String(spawnState.inspectRunning);
    } else if (args[0] === "inspect" && args[2]?.includes("openclaw.configHash")) {
      stdout = spawnState.labelHash;
    } else if (args[0] === "rm") {
      spawnState.containerExists = false;
      spawnState.inspectRunning = false;
    } else if (args[0] === "create") {
      expect(spawnState.containerExists).toBe(false);
      spawnState.containerExists = true;
      spawnState.labelHash =
        collectDockerFlagValues(args, "--label")
          .find((label) => label.startsWith("openclaw.configHash="))
          ?.slice("openclaw.configHash=".length) ?? "";
    } else if (args[0] === "start") {
      spawnState.inspectRunning = true;
    } else {
      throw new Error(`Unexpected Docker command ${args[0]}`);
    }
    return { stdout, stderr: "", code };
  }),
}));

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-refresh-"));
  tmpDirs.push(dir);
  return dir;
}

function createSandboxConfig(
  dns: string[],
  binds?: string[],
  workspaceAccess: "rw" | "ro" | "none" = "rw",
  env: Record<string, string> = { LANG: "C.UTF-8" },
): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "shared",
    workspaceAccess,
    workspaceRoot: "~/.openclaw/sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env,
      dns,
      extraHosts: ["host.docker.internal:host-gateway"],
      binds: binds ?? ["/tmp/workspace:/workspace:rw"],
      dangerouslyAllowReservedContainerTargets: true,
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-browser:test",
      containerPrefix: "oc-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

async function createMaskedRoomContainer(hasPreviousSkill = true, aliasedSkillRoot = false) {
  const workspaceDir = fs.realpathSync(makeTempDir());
  const skillsWorkspaceDir = fs.realpathSync(makeTempDir());
  const mask = path.join(skillsWorkspaceDir, ".excluded-skill-empty");
  const sources = [
    { hostPath: path.join(skillsWorkspaceDir, "managed"), containerPath: "/opt/managed-skills" },
    { hostPath: path.join(skillsWorkspaceDir, "bundled"), containerPath: "/opt/bundled-skills" },
  ];
  for (const mount of sources) {
    fs.mkdirSync(mount.hostPath);
  }
  fs.mkdirSync(path.join(skillsWorkspaceDir, "skills"));
  fs.mkdirSync(mask);
  const skillRoot = aliasedSkillRoot ? "real-skills" : "skills";
  if (hasPreviousSkill) {
    fs.mkdirSync(path.join(workspaceDir, skillRoot, "sheet"), { recursive: true });
    if (aliasedSkillRoot) {
      fs.symlinkSync(
        process.platform === "win32" ? path.join(workspaceDir, skillRoot) : skillRoot,
        path.join(workspaceDir, "skills"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  }
  const params = {
    cfg: { ...createSandboxConfig([], []), scope: "agent" as const },
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    skillsWorkspaceDir,
    scopeKey: `agent:managed-room:workspace:${"0".repeat(32)}`,
    requireCurrentConfig: true,
    reconcileSandboxSkillMounts: true as const,
    readOnlySkillMounts: sources,
  };
  spawnState.containerExists = false;
  registryMocks.readRegistryEntry.mockResolvedValue(null);
  await ensureSandboxContainer({
    ...params,
    readOnlySkillMounts: hasPreviousSkill
      ? [{ hostPath: mask, containerPath: `/workspace/${skillRoot}/sheet` }, ...sources]
      : sources,
  });
  const create = spawnState.calls.find((call) => call.args[0] === "create");
  expect(create).toBeDefined();
  const binds = collectDockerFlagValues(create!.args, "-v");
  spawnState.inspectManagedBinds = [
    "a".repeat(64),
    "1",
    params.scopeKey,
    spawnState.labelHash,
    JSON.stringify(binds.toReversed()),
  ].join("\n");
  registryMocks.readRegistryEntry.mockResolvedValue({ lastUsedAtMs: Date.now() });
  spawnState.calls.length = 0;
  if (!hasPreviousSkill) {
    fs.mkdirSync(path.join(workspaceDir, "skills", "sheet"), { recursive: true });
  }
  return params;
}

describe("restricted Docker skill mount reconciliation", () => {
  beforeEach(() => {
    spawnState.calls.length = 0;
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
    spawnState.labelHash = "";
    spawnState.inspectManagedBinds = "";
    spawnState.activeProcessSessions = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["recent", "idle", "stopped", "first-install", "aliased"] as const)(
    "recreates a %s room container when its existing hash proves skill-only drift",
    async (state) => {
      const params = await createMaskedRoomContainer(
        state !== "first-install",
        state === "aliased",
      );
      const turn = beginAgentWorkAdmission("managed-room");
      try {
        if (state === "idle" || state === "stopped") {
          registryMocks.readRegistryEntry.mockResolvedValue({ lastUsedAtMs: 1 });
        }
        spawnState.inspectRunning = state !== "stopped";
        await turn.run(() => ensureSandboxContainer(params));
      } finally {
        turn();
      }
      expect(spawnState.calls).toEqual(
        expect.arrayContaining([expect.objectContaining({ args: ["rm", "-f", "a".repeat(64)] })]),
      );
      const createCall = spawnState.calls.find((call) => call.args[0] === "create");
      expect(createCall?.args.some((arg) => arg.includes(".excluded-skill-empty"))).toBe(false);
      if (state !== "aliased") {
        expect(createCall?.args.some((arg) => arg.endsWith(":/workspace/skills:ro,z"))).toBe(true);
      }
    },
  );

  it.each(["admitted", "detached"] as const)(
    "defers verified skill refresh with %s work even after the hot window expires",
    async (activity) => {
      const params = await createMaskedRoomContainer();
      registryMocks.readRegistryEntry.mockResolvedValue({ lastUsedAtMs: 1 });
      const turn = beginAgentWorkAdmission("managed-room");
      const competing =
        activity === "admitted" ? beginAgentWorkAdmission("managed-room") : undefined;
      if (activity === "detached") {
        spawnState.activeProcessSessions = [{ sessionKey: "agent:managed-room:main" }];
      }
      try {
        await expect(turn.run(() => ensureSandboxContainer(params))).rejects.toMatchObject({
          code: "sandbox-skill-refresh-busy",
        });
      } finally {
        competing?.();
        turn();
        spawnState.activeProcessSessions = [];
      }
      expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(false);
      expect(spawnState.calls.some((call) => call.args[0] === "create")).toBe(false);
    },
  );

  it.each(["personal", "network", "unknown-bind", "browser"] as const)(
    "preserves restricted hot mismatch rejection for %s drift",
    async (reason) => {
      const params = await createMaskedRoomContainer();
      const cfg = {
        ...params.cfg,
        ...(reason === "network" ? { docker: { ...params.cfg.docker, network: "bridge" } } : {}),
        ...(reason === "browser" ? { browser: { ...params.cfg.browser, enabled: true } } : {}),
      };
      if (reason === "unknown-bind") {
        const lines = spawnState.inspectManagedBinds.split("\n");
        const binds = JSON.parse(lines[4]!) as string[];
        lines[4] = JSON.stringify([...binds, "/tmp/unknown:/unknown:ro,z"]);
        spawnState.inspectManagedBinds = lines.join("\n");
      }
      const { reconcileSandboxSkillMounts, ...personalParams } = params;
      await expect(
        ensureSandboxContainer({
          ...personalParams,
          cfg,
          ...(reason === "personal" ? {} : { reconcileSandboxSkillMounts }),
        }),
      ).rejects.toThrow("restricted dispatch requires the current container config");
      expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(false);
      expect(spawnState.calls.some((call) => call.args[0] === "create")).toBe(false);
    },
  );
});
