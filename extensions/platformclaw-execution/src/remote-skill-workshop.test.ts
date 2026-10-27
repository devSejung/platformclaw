import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { RunSshSandboxCommandParams } from "openclaw/plugin-sdk/sandbox";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it, vi } from "vitest";
import type { AssignedVmTargetSnapshot, PlatformClawExecutionTargetSnapshot } from "./backend.js";
import { VmRemoteSkillWorkshopService } from "./remote-skill-workshop.js";
import { PlatformClawTargetMutationCoordinator } from "./target-mutation-coordinator.js";

const TARGET: AssignedVmTargetSnapshot = {
  kind: "assigned_vm",
  agentId: "person_one",
  targetId: "vm-one",
  revision: 3,
  allocationId: "allocation-one",
  credentialRevision: 3,
  vmLabel: "Development VM",
  safeConnectLabel: "Corporate access",
  remoteHomeDir: "/users/person.one",
  remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
  endpointHost: "safeconnect.example",
  endpointPort: 44422,
  adDomain: "example.com",
  adAccount: "person.one",
  targetAddress: "192.0.2.10",
  linuxAccount: "person.one",
  hostKeyAlgorithm: "ssh-ed25519",
  hostKeyPublicKey: "AAAA-approved-key",
  hostKeyFingerprint: "SHA256:approved",
  codingAgents: [],
};

async function runLocalRemoteCommand(
  params: RunSshSandboxCommandParams,
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", params.remoteCommand], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const onAbort = () => child.kill("SIGTERM");
    params.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      params.signal?.removeEventListener("abort", onAbort);
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (result.code !== 0 && !params.allowFailure) {
        reject(new Error(result.stderr.toString("utf8").trim() || `shell exited ${result.code}`));
        return;
      }
      resolve(result);
    });
    child.stdin.end(params.stdin ?? Buffer.alloc(0));
  });
}

function createWorkshopHarness() {
  const mutations = new PlatformClawTargetMutationCoordinator();
  const session = { command: "ssh", configPath: "/tmp/config", host: "vm" };
  const io = {
    mutations,
    resolveTarget: vi.fn(async (): Promise<PlatformClawExecutionTargetSnapshot> => TARGET),
    createSession: vi.fn(async () => session),
    disposeSession: vi.fn(async () => undefined),
    runCommand: vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 })),
  };
  const refreshCatalog = vi.fn(async () => ({ revision: "initial", files: [] }));
  const access = new VmRemoteSkillWorkshopService(io).createAccess({
    target: TARGET,
    refreshCatalog,
  });
  const skillDir = `${TARGET.remoteWorkspaceDir}/skills/demo`;
  const mutate = () =>
    access.mutateSkill({ mode: "create", skillDir, expectedTree: [], files: [] });
  return { io, mutations, session, access, skillDir, mutate, refreshCatalog };
}

describe("VM remote Skill Workshop", () => {
  it.each([
    "target-change",
    "skill-install",
    "skill-export",
    "skill-workshop",
    "terminal-open",
  ] as const)("rejects mutation during %s before opening SSH", async (kind) => {
    const h = createWorkshopHarness();
    const release = h.mutations.tryAcquire(TARGET.agentId, kind);
    try {
      await expect(h.mutate()).rejects.toThrow("mutation is already in progress");
      expect(h.io.createSession).not.toHaveBeenCalled();
      expect(h.io.runCommand).not.toHaveBeenCalled();
      if (kind === "target-change") {
        await expect(h.access.readSkillTree(h.skillDir)).rejects.toThrow(
          "mutation is already in progress",
        );
        expect(h.io.createSession).not.toHaveBeenCalled();
      }
    } finally {
      release?.();
    }
  });

  it("guards catalog refresh and rejects stale refresh without opening SSH", async () => {
    const h = createWorkshopHarness();
    h.refreshCatalog.mockImplementationOnce(async () => {
      expect(h.mutations.tryAcquire(TARGET.agentId, "target-change")).toBeNull();
      return { revision: "refreshed", files: [] };
    });
    await h.access.listSkills();
    expect(h.refreshCatalog).toHaveBeenCalledOnce();
    expect(h.mutations.isHeld(TARGET.agentId)).toBe(false);
    h.io.resolveTarget.mockResolvedValue({ ...TARGET, revision: TARGET.revision + 1 });
    await expect(h.access.notifyChanged?.()).rejects.toThrow("target changed");
    expect(h.refreshCatalog).toHaveBeenCalledOnce();
    expect(h.mutations.isHeld(TARGET.agentId)).toBe(false);
  });

  it("rejects stale filesystem bridge access before opening SSH", async () => {
    const h = createWorkshopHarness();
    h.io.resolveTarget.mockResolvedValue({ ...TARGET, revision: TARGET.revision + 1 });
    await expect(
      h.access.fsBridge.readFile({ filePath: `${h.skillDir}/SKILL.md` }),
    ).rejects.toThrow("target changed");
    expect(h.io.createSession).not.toHaveBeenCalled();
    expect(h.io.runCommand).not.toHaveBeenCalled();
    expect(h.mutations.isHeld(TARGET.agentId)).toBe(false);
  });

  it("holds the shared guard across SSH authentication, command, and cleanup", async () => {
    const h = createWorkshopHarness();
    let authenticate!: (session: typeof h.session) => void;
    let finishCommand!: (result: Awaited<ReturnType<typeof h.io.runCommand>>) => void;
    let finishCleanup!: () => void;
    h.io.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          authenticate = resolve;
        }),
    );
    h.io.runCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCommand = resolve;
        }),
    );
    h.io.disposeSession.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishCleanup = () => resolve(undefined);
        }),
    );
    const pending = h.mutate();
    await vi.waitFor(() => expect(h.io.createSession).toHaveBeenCalledOnce());
    expect(h.mutations.tryAcquire(TARGET.agentId, "target-change")).toBeNull();
    authenticate(h.session);
    await vi.waitFor(() => expect(h.io.runCommand).toHaveBeenCalledOnce());
    expect(h.mutations.tryAcquire(TARGET.agentId, "target-change")).toBeNull();
    finishCommand({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 });
    await vi.waitFor(() => expect(h.io.disposeSession).toHaveBeenCalledOnce());
    expect(h.mutations.tryAcquire(TARGET.agentId, "target-change")).toBeNull();
    finishCleanup();
    await pending;
    expect(h.mutations.isHeld(TARGET.agentId)).toBe(false);
    expect(h.io.resolveTarget).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...TARGET, targetId: "another-saved-vm" },
    { ...TARGET, allocationId: "returned-allocation" },
    { ...TARGET, revision: TARGET.revision + 1 },
    { ...TARGET, credentialRevision: TARGET.credentialRevision + 1 },
    { ...TARGET, remoteHomeDir: "/users/reassigned" },
    { ...TARGET, remoteWorkspaceDir: "/users/person.one/other-workspace" },
    {
      kind: "platform_server",
      agentId: TARGET.agentId,
      targetId: "platform-server",
      revision: TARGET.revision + 1,
    },
  ] satisfies PlatformClawExecutionTargetSnapshot[])(
    "rejects stale Workshop access before it can replace the current SSH lease: %j",
    async (current) => {
      const h = createWorkshopHarness();
      h.io.resolveTarget.mockResolvedValue(current);
      await expect(h.mutate()).rejects.toThrow("target changed");
      expect(h.io.createSession).not.toHaveBeenCalled();
      expect(h.io.runCommand).not.toHaveBeenCalled();
      expect(h.mutations.isHeld(TARGET.agentId)).toBe(false);
    },
  );

  it("revalidates authority after authentication before sending a write", async () => {
    const h = createWorkshopHarness();
    h.io.resolveTarget
      .mockResolvedValueOnce(TARGET)
      .mockResolvedValueOnce({ ...TARGET, credentialRevision: TARGET.credentialRevision + 1 });
    await expect(h.mutate()).rejects.toThrow("target changed");
    expect(h.io.createSession).toHaveBeenCalledOnce();
    expect(h.io.runCommand).not.toHaveBeenCalled();
    expect(h.io.disposeSession).toHaveBeenCalledExactlyOnceWith(h.session);
    expect(h.mutations.isHeld(TARGET.agentId)).toBe(false);
  });

  it.each(["resolveTarget", "createSession", "runCommand", "disposeSession"] as const)(
    "releases mutation ownership when %s fails",
    async (stage) => {
      const h = createWorkshopHarness();
      h.io[stage].mockRejectedValueOnce(new Error("operation failed"));
      await expect(h.mutate()).rejects.toThrow("operation failed");
      expect(h.mutations.isHeld(TARGET.agentId)).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "creates, reads, updates, and CAS-protects a real VM-style skill tree",
    async () => {
      await withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "platformclaw-vm-workshop-" },
        async ({ dir }) => {
          const skillDir = path.join(dir, "workspace", "skills", "demo");
          const target = {
            ...TARGET,
            remoteHomeDir: dir,
            remoteWorkspaceDir: path.join(dir, "workspace"),
          };
          const firstSkill = "---\nname: demo\ndescription: First\n---\nRun it.\n";
          const secondSkill = "---\nname: demo\ndescription: Second\n---\nRun safely.\n";
          const reference = "# Reference\n";
          const service = new VmRemoteSkillWorkshopService({
            mutations: new PlatformClawTargetMutationCoordinator(),
            resolveTarget: async () => target,
            createSession: vi.fn(async () => ({
              command: "ssh",
              configPath: path.join(dir, "ssh-config"),
              host: "vm",
            })),
            disposeSession: vi.fn(async () => undefined),
            runCommand: runLocalRemoteCommand,
          });
          const access = service.createAccess({
            target,
            catalog: { revision: "initial", files: [] },
            refreshCatalog: vi.fn(async () => ({ revision: "next", files: [] })),
          });

          await access.mutateSkill({
            mode: "create",
            skillDir,
            expectedTree: [],
            files: [
              { path: "references/guide.md", content: Buffer.from(reference) },
              { path: "SKILL.md", content: Buffer.from(firstSkill) },
            ],
          });
          const createdTree = await access.readSkillTree(skillDir);
          expect(createdTree.map((file) => file.path)).toEqual(["SKILL.md", "references/guide.md"]);

          await access.mutateSkill({
            mode: "update",
            skillDir,
            expectedTree: createdTree,
            files: [{ path: "SKILL.md", content: Buffer.from(secondSkill) }],
          });
          expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(secondSkill);

          const updatedTree = await access.readSkillTree(skillDir);
          await fs.writeFile(path.join(skillDir, "SKILL.md"), `${secondSkill}external\n`);
          await expect(
            access.mutateSkill({
              mode: "update",
              skillDir,
              expectedTree: updatedTree,
              files: [{ path: "SKILL.md", content: Buffer.from(firstSkill) }],
            }),
          ).rejects.toThrow("VM skill target changed; reload and retry");
          expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toContain("external");
        },
      );
    },
  );

  it("pins proposals to saved VM identity across activations and refreshes the catalog after apply", async () => {
    const refreshCatalog = vi.fn(async () => ({
      revision: "next",
      files: [
        {
          source: "platformclaw-vm-workspace",
          filePath: `${TARGET.remoteWorkspaceDir}/skills/new-skill/SKILL.md`,
          content: "---\nname: new-skill\ndescription: New\n---\n",
        },
      ],
    }));
    const createSession = vi.fn(async () => ({
      command: "ssh",
      configPath: "/tmp/config",
      host: "vm",
    }));
    let activeTarget = TARGET;
    const service = new VmRemoteSkillWorkshopService({
      mutations: new PlatformClawTargetMutationCoordinator(),
      resolveTarget: async () => activeTarget,
      createSession,
      disposeSession: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      })),
    });
    const access = service.createAccess({
      target: TARGET,
      catalog: { revision: "initial", files: [] },
      refreshCatalog,
    });

    const restoredTarget = {
      ...TARGET,
      allocationId: "allocation-returned",
      revision: 5,
      credentialRevision: 4,
    };
    const restoredAccess = service.createAccess({ target: restoredTarget, refreshCatalog });
    const otherAccess = service.createAccess({
      target: { ...restoredTarget, targetId: "vm-two", allocationId: "allocation-two" },
      refreshCatalog,
    });
    expect(access.targetId).toBe(TARGET.targetId);
    expect(restoredAccess.targetId).toBe(access.targetId);
    expect(otherAccess.targetId).not.toBe(access.targetId);
    activeTarget = restoredTarget;
    await restoredAccess.readSkillTree(`${TARGET.remoteWorkspaceDir}/skills/new-skill`);
    expect(createSession).toHaveBeenCalledWith(restoredTarget);
    expect(await access.listSkills()).toEqual([]);
    await restoredAccess.notifyChanged?.();
    expect(await restoredAccess.listSkills()).toEqual([
      expect.objectContaining({ name: "new-skill", skillKey: "new-skill" }),
    ]);
    expect(refreshCatalog).toHaveBeenCalledOnce();
  });
});
