import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import {
  VM_REMOTE_SKILL_EXPORT_PYTHON,
  VmRemoteSkillExportService,
} from "./remote-skill-export.js";

const TARGET: AssignedVmTargetSnapshot = {
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

async function withPrivateDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "platformclaw-vm-export-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeProcess(params: { stdout?: Buffer; stderr?: string; code?: number }): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdout,
    stderr,
    kill: vi.fn(() => true),
  });
  queueMicrotask(() => {
    if (params.stderr) {
      stderr.write(params.stderr);
    }
    stderr.end();
    stdout.end(params.stdout ?? Buffer.alloc(0));
    stdout.once("end", () => {
      child.emit("close", params.code ?? 0, null);
    });
  });
  return child;
}

function mockedIo(directory: string, child: ChildProcess) {
  const session = { command: "ssh", configPath: "/private/config", host: "vm" };
  return {
    createSession: vi.fn(async () => session),
    disposeSession: vi.fn(async () => undefined),
    spawnProcess: vi.fn((_command: string, _args: string[], _options: SpawnOptions) => child),
    tempRoot: directory,
  };
}

type LocalFixture = {
  root: string;
  skillDir: string;
  target: AssignedVmTargetSnapshot;
  service: VmRemoteSkillExportService;
  disposeSession: ReturnType<typeof vi.fn>;
};

async function withLocalSkill(run: (fixture: LocalFixture) => Promise<void>): Promise<void> {
  await withPrivateDirectory(async (root) => {
    const workspace = path.join(root, "workspace");
    const skillDir = path.join(workspace, "skills", "demo-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demonstration\n---\nUse it.\n",
    );
    const target = { ...TARGET, remoteHomeDir: root, remoteWorkspaceDir: workspace };
    const disposeSession = vi.fn(async () => undefined);
    const service = new VmRemoteSkillExportService({
      createSession: vi.fn(async () => ({
        command: "ssh",
        configPath: path.join(root, "ssh-config"),
        host: "vm",
      })),
      disposeSession,
      spawnProcess: (_command, _args, options) =>
        spawn(
          "python3",
          ["-c", VM_REMOTE_SKILL_EXPORT_PYTHON, workspace, "demo-skill", "2.1.0"],
          options,
        ),
      tempRoot: root,
    });
    await run({ root, skillDir, target, service, disposeSession });
  });
}

describe("VM remote skill export", () => {
  it("streams SSH output into a private owned archive and disposes the authenticated lease", async () => {
    await withPrivateDirectory(async (root) => {
      const payload = Buffer.from("private skill archive payload over twenty-two bytes");
      const io = mockedIo(root, fakeProcess({ stdout: payload }));
      const archive = await new VmRemoteSkillExportService(io).export({
        target: TARGET,
        slug: "demo-skill",
        version: "1.2.3",
      });

      expect(await readFile(archive.path)).toEqual(payload);
      expect(archive.size).toBe(payload.byteLength);
      expect(io.disposeSession).toHaveBeenCalledOnce();
      const command = io.spawnProcess.mock.calls[0];
      expect(command?.[0]).toBe("ssh");
      expect(command?.[1].at(-1)).toContain("python3");
      expect(command?.[1].at(-1)).toContain("/srv/person-one/workspace");
      if (process.platform !== "win32") {
        expect((await stat(archive.path)).mode & 0o777).toBe(0o600);
      }
      await archive.cleanup();
      expect(await readdir(root)).toEqual([]);
    });
  });

  it("rejects unsafe identifiers and pre-aborted exports before opening an SSH session", async () => {
    await withPrivateDirectory(async (root) => {
      const io = mockedIo(root, fakeProcess({ stdout: Buffer.alloc(32) }));
      const service = new VmRemoteSkillExportService(io);
      await expect(
        service.export({ target: TARGET, slug: "../secret", version: "1.0.0" }),
      ).rejects.toThrow("slug is invalid");
      await expect(
        service.export({ target: TARGET, slug: "demo-skill", version: "1.0.0\nsecret" }),
      ).rejects.toThrow("version is invalid");
      await expect(
        service.export({
          target: { ...TARGET, remoteWorkspaceDir: "/srv/person-one/../secret" },
          slug: "demo-skill",
          version: "1.0.0",
        }),
      ).rejects.toThrow("workspace is invalid");
      const controller = new AbortController();
      controller.abort(new Error("export cancelled"));
      await expect(
        service.export({
          target: TARGET,
          slug: "demo-skill",
          version: "1.0.0",
          signal: controller.signal,
        }),
      ).rejects.toThrow("export cancelled");
      expect(io.createSession).not.toHaveBeenCalled();
    });
  });

  it("cleans private output and preserves bounded remote diagnostics after SSH failure", async () => {
    await withPrivateDirectory(async (root) => {
      const io = mockedIo(
        root,
        fakeProcess({
          stdout: Buffer.from("partial archive"),
          stderr: "VM skill export failed: skill contains a symbolic link\n",
          code: 65,
        }),
      );
      await expect(
        new VmRemoteSkillExportService(io).export({
          target: TARGET,
          slug: "demo-skill",
          version: "1.0.0",
        }),
      ).rejects.toThrow("symbolic link");
      expect(io.disposeSession).toHaveBeenCalledOnce();
      expect(await readdir(root)).toEqual([]);
    });
  });

  it.runIf(process.platform !== "win32")(
    "packages a real VM skill, updates only published metadata, and excludes secrets",
    async () => {
      await withLocalSkill(async ({ skillDir, target, service, disposeSession }) => {
        await mkdir(path.join(skillDir, "references"));
        await mkdir(path.join(skillDir, ".git"));
        await writeFile(path.join(skillDir, "references", "guide.md"), "safe guide\n");
        await writeFile(path.join(skillDir, ".git", "config"), "private git settings");
        await writeFile(path.join(skillDir, ".env"), "TOKEN=secret");
        await writeFile(path.join(skillDir, "private.pem"), "secret key");

        const archive = await service.export({ target, slug: "demo-skill", version: "2.1.0" });
        const result = JSON.parse(
          execFileSync(
            "python3",
            [
              "-c",
              "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'names':z.namelist(),'markdown':z.read('SKILL.md').decode(),'flags':[i.flag_bits for i in z.infolist()]}))",
              archive.path,
            ],
            { encoding: "utf8" },
          ),
        ) as { names: string[]; markdown: string; flags: number[] };

        expect(result.names).toEqual(["SKILL.md", "references/guide.md"]);
        expect(result.markdown).toContain('version: "2.1.0"');
        expect(result.flags.every((flags) => (flags & ~0x800) === 0)).toBe(true);
        expect(await readFile(path.join(skillDir, "SKILL.md"), "utf8")).not.toContain("version:");
        expect(disposeSession).toHaveBeenCalledOnce();
        await archive.cleanup();
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symbolic links and hard-linked VM files",
    async () => {
      await withLocalSkill(async ({ root, skillDir, target, service, disposeSession }) => {
        const outside = path.join(root, "outside-secret");
        await writeFile(outside, "secret");
        await symlink(outside, path.join(skillDir, "linked-secret"));
        await expect(
          service.export({ target, slug: "demo-skill", version: "2.1.0" }),
        ).rejects.toThrow("symbolic link");
        await rm(path.join(skillDir, "linked-secret"));
        await link(outside, path.join(skillDir, "hard-linked-secret"));
        await expect(
          service.export({ target, slug: "demo-skill", version: "2.1.0" }),
        ).rejects.toThrow("hard-linked");
        expect(disposeSession).toHaveBeenCalledTimes(2);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "enforces archive file-count and per-entry limits",
    async () => {
      await withLocalSkill(async ({ skillDir, target, service }) => {
        for (let index = 0; index < 100; index += 1) {
          await writeFile(path.join(skillDir, `file-${String(index).padStart(3, "0")}.txt`), "x");
        }
        await expect(
          service.export({ target, slug: "demo-skill", version: "2.1.0" }),
        ).rejects.toThrow("100-file limit");
        for (let index = 0; index < 100; index += 1) {
          await rm(path.join(skillDir, `file-${String(index).padStart(3, "0")}.txt`));
        }
        const oversized = path.join(skillDir, "oversized.bin");
        await writeFile(oversized, "");
        await truncate(oversized, 250 * 1024 * 1024 + 1);
        await expect(
          service.export({ target, slug: "demo-skill", version: "2.1.0" }),
        ).rejects.toThrow("250 MiB limit");
      });
    },
  );
});
