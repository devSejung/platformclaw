import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it, vi } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import { VM_REMOTE_SKILL_SCAN_SCRIPT, VmRemoteSkillCatalogService } from "./remote-skills.js";

const execFileAsync = promisify(execFile);

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

function encodedLine(source: string, filePath: string, content: string): Buffer {
  return Buffer.from(
    `@platform\tlinux\t${Buffer.from("bash\nnode\n").toString("base64")}\n${source}\t${Buffer.from(filePath).toString("base64")}\t${Buffer.from(content).toString("base64")}\n`,
  );
}

describe("VM remote skill catalog", () => {
  it("scans distinct workspace, global, and built-in roots in precedence order", () => {
    const workspace = VM_REMOTE_SKILL_SCAN_SCRIPT.indexOf(
      'scan_root "$workspace/skills" "platformclaw-vm-workspace"',
    );
    const global = VM_REMOTE_SKILL_SCAN_SCRIPT.indexOf(
      'scan_root "/opt/platformclaw/skills" "platformclaw-vm-managed"',
    );
    const bundled = VM_REMOTE_SKILL_SCAN_SCRIPT.indexOf(
      'scan_root "/opt/platformclaw/bundle" "platformclaw-vm-bundled"',
    );

    expect(workspace).toBeGreaterThanOrEqual(0);
    expect(global).toBeGreaterThan(workspace);
    expect(bundled).toBeGreaterThan(global);
  });

  it.runIf(process.platform !== "win32")(
    "executes the real scanner against a workspace skill",
    async () => {
      await withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "platformclaw-vm-skills-" },
        async ({ dir }) => {
          const workspace = path.join(dir, "workspace");
          const home = path.join(dir, "home");
          const skillPath = path.join(workspace, "skills", "demo", "SKILL.md");
          await fs.mkdir(path.dirname(skillPath), { recursive: true });
          await fs.mkdir(home, { recursive: true });
          await fs.writeFile(
            skillPath,
            "---\nname: demo\ndescription: Real scanner demo\n---\nRun it.\n",
          );

          const { stdout } = await execFileAsync(
            "/bin/bash",
            ["-c", VM_REMOTE_SKILL_SCAN_SCRIPT, "platformclaw-skill-scan-test", workspace],
            { encoding: "utf8", env: { ...process.env, HOME: home } },
          );

          expect(stdout).toContain(Buffer.from(skillPath).toString("base64"));
          expect(stdout).toContain("platformclaw-vm-workspace");
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails the real scanner instead of returning a truncated catalog",
    async () => {
      await withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "platformclaw-vm-skills-limit-" },
        async ({ dir }) => {
          const workspace = path.join(dir, "workspace");
          const home = path.join(dir, "home");
          await fs.mkdir(home, { recursive: true });
          await Promise.all(
            Array.from({ length: 129 }, async (_, index) => {
              const skillPath = path.join(workspace, "skills", `demo-${index}`, "SKILL.md");
              await fs.mkdir(path.dirname(skillPath), { recursive: true });
              await fs.writeFile(skillPath, "---\nname: demo\ndescription: Demo\n---\n");
            }),
          );

          await expect(
            execFileAsync(
              "/bin/bash",
              ["-c", VM_REMOTE_SKILL_SCAN_SCRIPT, "platformclaw-skill-scan-test", workspace],
              { encoding: "utf8", env: { ...process.env, HOME: home } },
            ),
          ).rejects.toMatchObject({ code: 75 });
        },
      );
    },
  );

  it("scans the selected VM once, caches it, and refreshes explicitly", async () => {
    const session = { command: "ssh", configPath: "/tmp/config", host: "vm" };
    const createSession = vi.fn(async () => session);
    const disposeSession = vi.fn(async () => undefined);
    const runCommand = vi.fn(async () => ({
      stdout: encodedLine(
        "platformclaw-vm-bundled",
        "/opt/platformclaw/bundle/release/SKILL.md",
        "---\nname: release\ndescription: Release safely\n---\nRun the script.",
      ),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    const service = new VmRemoteSkillCatalogService({
      createSession,
      disposeSession,
      runCommand,
    });

    const [first, concurrent] = await Promise.all([
      service.list(TARGET, false),
      service.list(TARGET, false),
    ]);
    const cached = await service.list(TARGET, false);
    const refreshed = await service.list(TARGET, true);

    expect(first).toBe(cached);
    expect(first).toBe(concurrent);
    expect(refreshed).not.toBe(first);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(disposeSession).toHaveBeenCalledTimes(2);
    expect(first.files).toEqual([
      expect.objectContaining({
        source: "platformclaw-vm-bundled",
        filePath: "/opt/platformclaw/bundle/release/SKILL.md",
      }),
    ]);
    expect(first.eligibility).toEqual({ bins: ["bash", "node"], platforms: ["linux"] });
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        remoteCommand: expect.stringContaining(TARGET.remoteWorkspaceDir),
      }),
    );
  });

  it("rejects malformed scanner output", async () => {
    const service = new VmRemoteSkillCatalogService({
      createSession: async () => ({ command: "ssh", configPath: "/tmp/config", host: "vm" }),
      disposeSession: async () => undefined,
      runCommand: async () => ({
        stdout: Buffer.from("broken\n"),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    });

    await expect(service.list(TARGET, false)).rejects.toThrow("platform response is invalid");
  });

  it("allows empty skill content so only that invalid skill is discarded later", async () => {
    const service = new VmRemoteSkillCatalogService({
      createSession: async () => ({ command: "ssh", configPath: "/tmp/config", host: "vm" }),
      disposeSession: async () => undefined,
      runCommand: async () => ({
        stdout: encodedLine(
          "platformclaw-vm-workspace",
          "/users/person.one/skills/empty/SKILL.md",
          "",
        ),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    });

    const catalog = await service.list(TARGET, false);

    expect(catalog.files).toEqual([
      expect.objectContaining({
        content: "",
        filePath: "/users/person.one/skills/empty/SKILL.md",
      }),
    ]);
  });

  it("rejects unsuccessful and oversized scans without caching them", async () => {
    const createSession = vi.fn(async () => ({
      command: "ssh",
      configPath: "/tmp/config",
      host: "vm",
    }));
    const disposeSession = vi.fn(async () => undefined);
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: encodedLine("platformclaw-vm-workspace", "/x/SKILL.md", "ok"),
        stderr: Buffer.alloc(0),
        code: 1,
      })
      .mockResolvedValueOnce({
        stdout: encodedLine("platformclaw-vm-workspace", "/x/SKILL.md", "x".repeat(64 * 1024 + 1)),
        stderr: Buffer.alloc(0),
        code: 0,
      });
    const service = new VmRemoteSkillCatalogService({
      createSession,
      disposeSession,
      runCommand,
    });

    await expect(service.list(TARGET, false)).rejects.toThrow("scan failed");
    await expect(service.list(TARGET, false)).rejects.toThrow("entry exceeded the limit");
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(disposeSession).toHaveBeenCalledTimes(2);
  });
});
