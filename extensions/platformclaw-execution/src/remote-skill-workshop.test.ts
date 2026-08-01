import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it, vi } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import {
  VM_REMOTE_SKILL_TREE_MUTATE_SCRIPT,
  VM_REMOTE_SKILL_TREE_READ_SCRIPT,
  VmRemoteSkillWorkshopService,
} from "./remote-skill-workshop.js";

const TARGET: AssignedVmTargetSnapshot = {
  kind: "assigned_vm",
  agentId: "person_one",
  targetId: "vm-one",
  revision: 3,
  allocationId: "allocation-one",
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

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function encodePath(filePath: string): string {
  return Buffer.from(filePath, "utf8").toString("base64");
}

function expected(filePath: string, content: string): string {
  return ["E", encodePath(filePath), sha256(content), Buffer.byteLength(content)].join("\t");
}

function write(filePath: string, content: string): string {
  return [
    "W",
    encodePath(filePath),
    Buffer.from(content, "utf8").toString("base64"),
    Buffer.byteLength(content),
  ].join("\t");
}

async function runBashScript(params: {
  script: string;
  args: string[];
  stdin?: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "/bin/bash",
      ["-c", params.script, "platformclaw-workshop-test", ...params.args],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(params.stdin ?? "");
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
          const firstSkill = "---\nname: demo\ndescription: First\n---\nRun it.\n";
          const secondSkill = "---\nname: demo\ndescription: Second\n---\nRun safely.\n";
          const reference = "# Reference\n";

          const created = await runBashScript({
            script: VM_REMOTE_SKILL_TREE_MUTATE_SCRIPT,
            args: [skillDir, "create"],
            stdin: `${write("references/guide.md", reference)}\n${write("SKILL.md", firstSkill)}\n`,
          });
          expect(created).toMatchObject({ code: 0, stderr: "" });

          const read = await runBashScript({
            script: VM_REMOTE_SKILL_TREE_READ_SCRIPT,
            args: [skillDir],
          });
          expect(read.code).toBe(0);
          expect(read.stdout).toContain(encodePath("SKILL.md"));
          expect(read.stdout).toContain(encodePath("references/guide.md"));

          const updated = await runBashScript({
            script: VM_REMOTE_SKILL_TREE_MUTATE_SCRIPT,
            args: [skillDir, "update"],
            stdin: [
              expected("SKILL.md", firstSkill),
              expected("references/guide.md", reference),
              write("SKILL.md", secondSkill),
              "",
            ].join("\n"),
          });
          expect(updated).toMatchObject({ code: 0, stderr: "" });
          expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(secondSkill);

          await fs.writeFile(path.join(skillDir, "SKILL.md"), `${secondSkill}external\n`);
          const conflicted = await runBashScript({
            script: VM_REMOTE_SKILL_TREE_MUTATE_SCRIPT,
            args: [skillDir, "update"],
            stdin: [
              expected("SKILL.md", secondSkill),
              expected("references/guide.md", reference),
              write("SKILL.md", firstSkill),
              "",
            ].join("\n"),
          });
          expect(conflicted.code).toBe(73);
          expect(conflicted.stderr).toContain("skill target changed");
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
