import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { RunSshSandboxCommandParams } from "openclaw/plugin-sdk/sandbox";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it, vi } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import { VmRemoteSkillWorkshopService } from "./remote-skill-workshop.js";

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

describe("VM remote Skill Workshop", () => {
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

  it("pins proposals to allocation identity and refreshes the catalog after apply", async () => {
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
    const service = new VmRemoteSkillWorkshopService({
      createSession: vi.fn(async () => ({ command: "ssh", configPath: "/tmp/config", host: "vm" })),
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

    expect(access.targetId).toBe(TARGET.allocationId);
    expect(await access.listSkills()).toEqual([]);
    await access.notifyChanged?.();
    expect(await access.listSkills()).toEqual([
      expect.objectContaining({ name: "new-skill", skillKey: "new-skill" }),
    ]);
    expect(refreshCatalog).toHaveBeenCalledOnce();
  });
});
