import { describe, expect, it, vi } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import { VmRemoteSkillInstallerService } from "./remote-skill-install.js";
import { VmRemoteSkillCatalogService } from "./remote-skills.js";

async function runLocalRemoteCommand(
  params: RunSshSandboxCommandParams,
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", params.remoteCommand], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }),
    );
    child.stdin.end(params.stdin ?? Buffer.alloc(0));
  });
}

const target: AssignedVmTargetSnapshot = {
  kind: "assigned_vm",
  agentId: "person-one",
  revision: 4,
  targetId: "vm-one",
  allocationId: "allocation-one",
  credentialRevision: 3,
  vmLabel: "Development VM",
  safeConnectLabel: "Corporate access",
  remoteHomeDir: "/srv/person-one",
  remoteWorkspaceDir: "/srv/person-one/workspace",
  endpointHost: "safeconnect.example",
  endpointPort: 44422,
  adDomain: "example",
  adAccount: "person.one",
  targetAddress: "192.0.2.1",
  linuxAccount: "person.one",
  hostKeyAlgorithm: "ssh-ed25519",
  hostKeyPublicKey: "AAAA-test",
  hostKeyFingerprint: "SHA256:test",
};

function fixture() {
  const session = { command: "ssh", args: [], configPath: "/tmp/config", host: "vm" };
  const runCommand = vi
    .fn()
    .mockResolvedValueOnce({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 })
    .mockResolvedValue({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 });
  const io = {
    createSession: vi.fn(async () => session),
    disposeSession: vi.fn(async () => undefined),
    uploadDirectory: vi.fn(async () => undefined),
    runCommand,
  };
  const refreshCatalog = vi.fn(async () => undefined);
  const access = new VmRemoteSkillInstallerService(io as never).createAccess({
    target,
    refreshCatalog,
  });
  return { access, io, refreshCatalog };
}

describe("VM remote skill installer", () => {
  it("stages inside the remote workspace and refreshes after atomic installation", async () => {
    const { access, io, refreshCatalog } = fixture();

    await expect(
      access.install({
        sourceDir: "/local/extracted",
        slug: "demo-skill",
        mode: "install",
        timeoutMs: 30_000,
      }),
    ).resolves.toEqual({ targetDir: "/srv/person-one/workspace/skills/demo-skill" });
    expect(io.uploadDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        localDir: "/local/extracted",
        remoteRootDir: "/srv/person-one/workspace",
        remoteDir: expect.stringMatching(
          /^\/srv\/person-one\/workspace\/\.openclaw\/skill-installs\/[0-9a-f-]+$/u,
        ),
      }),
    );
    expect(refreshCatalog).toHaveBeenCalledOnce();
    expect(io.disposeSession).toHaveBeenCalledOnce();
  });

  it("routes updates through the remote rollback-preserving replacement script", async () => {
    const { access, io, refreshCatalog } = fixture();

    await expect(
      access.install({
        sourceDir: "/local/extracted",
        slug: "demo-skill",
        mode: "update",
        timeoutMs: 30_000,
        expectedSkillRevision: "sha256:0123456789abcdef",
      }),
    ).resolves.toEqual({ targetDir: "/srv/person-one/workspace/skills/demo-skill" });
    const command = io.runCommand.mock.calls[0]?.[0]?.remoteCommand as string;
    expect(command).toContain("update");
    expect(command).toContain("platformclaw-skill-backup");
    expect(command).toContain("rollback");
    expect(refreshCatalog).toHaveBeenCalledOnce();
  });

  it("revision-pins remote removal and refreshes the catalog", async () => {
    const { access, io, refreshCatalog } = fixture();
    if (!access.remove) {
      throw new Error("remote skill removal test invariant");
    }

    await expect(
      access.remove({
        slug: "demo-skill",
        timeoutMs: 30_000,
        expectedSkillRevision: "sha256:0123456789abcdef",
      }),
    ).resolves.toEqual({ targetDir: "/srv/person-one/workspace/skills/demo-skill" });
    const command = io.runCommand.mock.calls[0]?.[0]?.remoteCommand as string;
    expect(command).toContain("platformclaw-skill-remove");
    expect(command).toContain("sha256:0123456789abcdef");
    expect(command).toContain("rollback");
    expect(refreshCatalog).toHaveBeenCalledOnce();
    expect(io.disposeSession).toHaveBeenCalledOnce();
  });

  it("cleans staging and disposes the SSH session after an upload failure", async () => {
    const { access, io, refreshCatalog } = fixture();
    io.uploadDirectory.mockRejectedValueOnce(new Error("upload failed"));

    await expect(
      access.install({
        sourceDir: "/local/extracted",
        slug: "demo-skill",
        mode: "install",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow("upload failed");
    expect(io.runCommand).toHaveBeenCalledOnce();
    expect(refreshCatalog).not.toHaveBeenCalled();
    expect(io.disposeSession).toHaveBeenCalledOnce();
  });

  it("replaces a primed VM catalog after a successful install", async () => {
    const session = { command: "ssh", args: [], configPath: "/tmp/config", host: "vm" };
    const encodeCatalog = (name: string) =>
      Buffer.from(
        `@platform\tlinux\t\nplatformclaw-vm-workspace\t${Buffer.from(`/srv/person-one/workspace/skills/${name}/SKILL.md`).toString("base64")}\t${Buffer.from(`---\nname: ${name}\ndescription: Demo\n---\n`).toString("base64")}\n`,
      );
    const catalogRunCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: encodeCatalog("old-skill"),
        stderr: Buffer.alloc(0),
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: encodeCatalog("demo-skill"),
        stderr: Buffer.alloc(0),
        code: 0,
      });
    const catalog = new VmRemoteSkillCatalogService({
      createSession: vi.fn(async () => session),
      disposeSession: vi.fn(async () => undefined),
      runCommand: catalogRunCommand,
    });
    await catalog.list(target, false);
    const installerRunCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 })
      .mockResolvedValue({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 });
    const access = new VmRemoteSkillInstallerService({
      createSession: vi.fn(async () => session),
      disposeSession: vi.fn(async () => undefined),
      uploadDirectory: vi.fn(async () => undefined),
      runCommand: installerRunCommand,
    } as never).createAccess({
      target,
      refreshCatalog: async () => await catalog.list(target, true),
    });

    await access.install({
      sourceDir: "/local/extracted",
      slug: "demo-skill",
      mode: "install",
      timeoutMs: 30_000,
    });
    const ordinaryRead = await catalog.list(target, false);

    expect(ordinaryRead.files[0]?.filePath).toContain("/demo-skill/SKILL.md");
    expect(catalogRunCommand).toHaveBeenCalledTimes(2);
  });

  it.runIf(process.platform !== "win32")(
    "installs a real staged tree atomically and rejects a collision",
    async () => {
      await withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "platformclaw-vm-install-" },
        async ({ dir }) => {
          const sourceDir = path.join(dir, "source");
          const workspaceDir = path.join(dir, "workspace");
          await fs.mkdir(sourceDir, { recursive: true });
          await fs.writeFile(
            path.join(sourceDir, "SKILL.md"),
            "---\nname: demo-skill\ndescription: Demo\n---\n",
          );
          const access = new VmRemoteSkillInstallerService({
            createSession: vi.fn(async () => ({
              command: "ssh",
              configPath: path.join(dir, "ssh-config"),
              host: "vm",
            })),
            disposeSession: vi.fn(async () => undefined),
            uploadDirectory: vi.fn(async ({ localDir, remoteDir }) => {
              await fs.mkdir(path.dirname(remoteDir), { recursive: true });
              await fs.cp(localDir, remoteDir, { recursive: true, errorOnExist: true });
            }),
            runCommand: runLocalRemoteCommand,
          }).createAccess({
            target: { ...target, remoteHomeDir: dir, remoteWorkspaceDir: workspaceDir },
            refreshCatalog: vi.fn(async () => undefined),
          });

          await access.install({
            sourceDir,
            slug: "demo-skill",
            mode: "install",
            timeoutMs: 30_000,
          });
          await expect(
            fs.readFile(path.join(workspaceDir, "skills", "demo-skill", "SKILL.md"), "utf8"),
          ).resolves.toContain("Demo");
          await expect(
            access.install({
              sourceDir,
              slug: "demo-skill",
              mode: "install",
              timeoutMs: 30_000,
            }),
          ).rejects.toThrow("already exists");
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a staged symbolic link before committing it",
    async () => {
      await withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "platformclaw-vm-install-link-" },
        async ({ dir }) => {
          const sourceDir = path.join(dir, "source");
          const workspaceDir = path.join(dir, "workspace");
          await fs.mkdir(sourceDir, { recursive: true });
          await fs.writeFile(path.join(sourceDir, "SKILL.md"), "safe");
          const access = new VmRemoteSkillInstallerService({
            createSession: vi.fn(async () => ({
              command: "ssh",
              configPath: "unused",
              host: "vm",
            })),
            disposeSession: vi.fn(async () => undefined),
            uploadDirectory: vi.fn(async ({ remoteDir }) => {
              await fs.mkdir(remoteDir, { recursive: true });
              await fs.writeFile(path.join(remoteDir, "SKILL.md"), "safe");
              await fs.symlink(path.join(dir, "outside"), path.join(remoteDir, "unsafe-link"));
            }),
            runCommand: runLocalRemoteCommand,
          }).createAccess({
            target: { ...target, remoteHomeDir: dir, remoteWorkspaceDir: workspaceDir },
            refreshCatalog: vi.fn(async () => undefined),
          });

          await expect(
            access.install({ sourceDir, slug: "demo-skill", mode: "install", timeoutMs: 30_000 }),
          ).rejects.toThrow("failed (65)");
          await expect(
            fs.stat(path.join(workspaceDir, "skills", "demo-skill")),
          ).rejects.toMatchObject({
            code: "ENOENT",
          });
        },
      );
    },
  );
});
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { RunSshSandboxCommandParams } from "openclaw/plugin-sdk/sandbox";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
