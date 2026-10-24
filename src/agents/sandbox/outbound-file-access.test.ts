import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import type { SandboxBackendCommandParams } from "./backend-handle.types.js";
import { createSandboxOutboundFileAccess } from "./outbound-file-access.js";
import { createRemoteShellSandboxFsBridge } from "./remote-fs-bridge.js";

const execFileAsync = promisify(execFile);

function createShellBackend(runtimeId: string) {
  return {
    runtimeId,
    workdir: "/workspace",
    runShellCommand: vi.fn(async (params: SandboxBackendCommandParams) => {
      try {
        const result = await execFileAsync(
          "/bin/sh",
          ["-c", params.script, "openclaw-outbound-test", ...(params.args ?? [])],
          {
            encoding: "buffer",
            maxBuffer: params.maxBufferBytes,
            signal: params.signal,
            timeout: 5000,
          },
        );
        return { ...result, code: 0 };
      } catch (error) {
        // Avoid matching expected diagnostics in the Python source included in
        // execFile's command text; assertions must see the actual stderr only.
        if (
          error instanceof Error &&
          "stderr" in error &&
          Buffer.isBuffer(error.stderr) &&
          error.stderr.length > 0
        ) {
          throw new Error(error.stderr.toString("utf8"), { cause: error });
        }
        throw error;
      }
    }),
  };
}

function createBridge() {
  return {
    resolvePath: vi.fn(() => ({
      relativePath: "report.txt",
      containerPath: "/workspace/report.txt",
    })),
    readFile: vi.fn(async () => Buffer.from("workspace")),
  };
}

// Exercise the production Python helper through its real shell-command boundary.
// SSH/container transport and foreign Unix accounts have separate runtime proof.
describe.skipIf(process.platform !== "linux")("sandbox outbound files", () => {
  it("keeps private temp stable per runtime and owner while isolating different owners", async () => {
    await withTempDir({ prefix: "openclaw-outbound-test-" }, async (root) => {
      const backend = createShellBackend(root);
      const bridge = createBridge();
      const first = await createSandboxOutboundFileAccess({
        backend,
        bridge,
        scopeKey: "one",
        workspaceDir: "/gateway/one",
      });
      const second = await createSandboxOutboundFileAccess({
        backend,
        bridge,
        scopeKey: "two",
        workspaceDir: "/gateway/two",
      });
      try {
        await fs.writeFile(path.join(first.tempDir, "keep.txt"), "survives next turn");
        const repeated = await createSandboxOutboundFileAccess({
          backend,
          bridge,
          scopeKey: "one",
          workspaceDir: "/gateway/one",
        });
        expect(repeated.tempDir).toBe(first.tempDir);
        expect(second.tempDir).not.toBe(first.tempDir);
        const directory = await fs.lstat(first.tempDir);
        expect(directory.isDirectory()).toBe(true);
        expect(directory.mode & 0o777).toBe(0o700);
        expect(directory.uid).toBe(process.geteuid?.());
        await expect(
          repeated.readFile({ filePath: path.join(first.tempDir, "keep.txt"), maxBytes: 100 }),
        ).resolves.toEqual(Buffer.from("survives next turn"));
      } finally {
        await fs.rm(first.tempDir, { recursive: true, force: true });
        await fs.rm(second.tempDir, { recursive: true, force: true });
      }
    });
  });

  it("reads arbitrary own /tmp bytes and preserves bridge resolution for home/workspace", async () => {
    await withTempDir({ prefix: "openclaw-outbound-read-" }, async (root) => {
      const backend = createShellBackend(root);
      const bridge = {
        ...createBridge(),
        resolveUserPath: vi.fn(() => ({
          relativePath: "notes.txt",
          containerPath: "/users/one/notes.txt",
        })),
      };
      const access = await createSandboxOutboundFileAccess({
        backend,
        bridge,
        scopeKey: "one",
        workspaceDir: "/gateway/one",
      });
      try {
        const bytes = Buffer.from([0, 1, 255, 10]);
        await fs.writeFile(path.join(root, "report.bin"), bytes);
        await expect(
          access.readFile({ filePath: path.join(root, "report.bin"), maxBytes: 4 }),
        ).resolves.toEqual(bytes);
        expect(bridge.readFile).not.toHaveBeenCalled();
        const controller = new AbortController();
        await expect(
          access.readFile({ filePath: "~/notes.txt", maxBytes: 20, signal: controller.signal }),
        ).resolves.toEqual(Buffer.from("workspace"));
        expect(bridge.resolveUserPath).toHaveBeenCalledWith({
          filePath: "~/notes.txt",
          cwd: "/gateway/one",
        });
        expect(bridge.readFile).toHaveBeenCalledWith({
          filePath: "/users/one/notes.txt",
          cwd: "/workspace",
          maxBytes: 20,
          signal: controller.signal,
        });
      } finally {
        await fs.rm(access.tempDir, { recursive: true, force: true });
      }
    });
  });

  it.each([
    { parentDir: undefined, symlinkWorkspace: false },
    { parentDir: process.cwd(), symlinkWorkspace: false },
    { parentDir: process.cwd(), symlinkWorkspace: true },
  ])("enforces workspace-only export with %j", async ({ parentDir, symlinkWorkspace }) => {
    await withTempDir({ prefix: "openclaw-outbound-workspace-", parentDir }, async (root) => {
      const actualWorkspace = path.join(root, "workspace");
      await fs.mkdir(actualWorkspace);
      const workdir = symlinkWorkspace ? path.join(root, "workspace-link") : actualWorkspace;
      if (symlinkWorkspace) {
        await fs.symlink(actualWorkspace, workdir);
      }
      await execFileAsync("mkfifo", [path.join(workdir, "fifo")]);
      await fs.writeFile(path.join(workdir, "report.txt"), "workspace bytes");
      await fs.writeFile(path.join(root, "home.txt"), "outside workspace");
      await fs.symlink(path.join(root, "home.txt"), path.join(workdir, "escape.txt"));
      await fs.symlink(root, path.join(workdir, "escape-dir"));
      await fs.symlink("report.txt", path.join(workdir, "inside-link.txt"));
      const backend = { ...createShellBackend(root), workdir };
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: {
          workspaceDir: "/gateway/one",
          agentWorkspaceDir: "/gateway/one",
          workspaceAccess: "rw",
          containerName: root,
          containerWorkdir: workdir,
          accountOwnedRoots: ["/tmp"],
          docker: {},
        },
        runtime: {
          remoteWorkspaceDir: workdir,
          remoteAgentWorkspaceDir: path.join(root, "agent"),
          remoteHomeDir: root,
          additionalFilesystemRoots: [{ root, access: "rw" }],
          runRemoteShellScript: backend.runShellCommand,
        },
      });
      const access = await createSandboxOutboundFileAccess({
        backend,
        bridge,
        scopeKey: "one",
        workspaceDir: "/gateway/one",
        workspaceOnly: true,
      });
      try {
        for (const filePath of [
          "report.txt",
          "~/workspace/report.txt",
          "/gateway/one/report.txt",
        ]) {
          await expect(access.readFile({ filePath, maxBytes: 100 })).resolves.toEqual(
            Buffer.from("workspace bytes"),
          );
        }
        for (const filePath of ["~/home.txt", path.join(root, "home.txt"), access.tempDir]) {
          await expect(access.readFile({ filePath, maxBytes: 100 })).rejects.toThrow(/workspace/u);
        }
        if (actualWorkspace.startsWith("/tmp/")) {
          await expect(
            access.readFile({ filePath: "inside-link.txt", maxBytes: 100 }),
          ).rejects.toThrow();
        } else {
          await expect(
            access.readFile({ filePath: "inside-link.txt", maxBytes: 100 }),
          ).resolves.toEqual(Buffer.from("workspace bytes"));
        }
        await expect(access.readFile({ filePath: "fifo", maxBytes: 100 })).rejects.toThrow(
          /^Traceback[\s\S]+only regular files are allowed/u,
        );
        for (const filePath of ["escape.txt", "escape-dir/home.txt"]) {
          await expect(access.readFile({ filePath, maxBytes: 100 })).rejects.toThrow();
        }
      } finally {
        await fs.rm(access.tempDir, { recursive: true, force: true });
      }
    });
  });

  it("rejects unsafe temp entries and bounded-read failures without a host fallback", async () => {
    await withTempDir({ prefix: "openclaw-outbound-reject-" }, async (root) => {
      const backend = createShellBackend(root);
      const bridge = createBridge();
      const access = await createSandboxOutboundFileAccess({
        backend,
        bridge,
        scopeKey: "one",
        workspaceDir: "/gateway/one",
      });
      try {
        const file = path.join(root, "file.txt");
        await fs.writeFile(file, "hello");
        await fs.symlink(file, path.join(root, "symlink.txt"));
        await fs.symlink(root, path.join(root, "alias"));
        await execFileAsync("mkfifo", [path.join(root, "fifo")]);
        for (const filePath of [
          path.join(root, "symlink.txt"),
          path.join(root, "alias/file.txt"),
          root,
        ]) {
          await expect(access.readFile({ filePath, maxBytes: 100 })).rejects.toThrow();
        }
        await expect(
          access.readFile({ filePath: path.join(root, "fifo"), maxBytes: 100 }),
        ).rejects.toThrow(/only regular files/u);
        await expect(
          access.readFile({ filePath: `${root}/alias/../file.txt`, maxBytes: 100 }),
        ).rejects.toThrow(/parent traversal/u);
        await expect(access.readFile({ filePath: file, maxBytes: 4 })).rejects.toThrow(
          /bounded read limit/u,
        );
        await fs.link(file, path.join(root, "hardlink.txt"));
        await expect(access.readFile({ filePath: file, maxBytes: 100 })).rejects.toThrow(
          /hardlinked/u,
        );
        expect(bridge.readFile).not.toHaveBeenCalled();
        await expect(access.readFile({ filePath: file, maxBytes: -1 })).rejects.toThrow(RangeError);
        const controller = new AbortController();
        controller.abort();
        const calls = backend.runShellCommand.mock.calls.length;
        await expect(
          access.readFile({ filePath: file, maxBytes: 100, signal: controller.signal }),
        ).rejects.toThrow();
        expect(backend.runShellCommand).toHaveBeenCalledTimes(calls);
      } finally {
        await fs.rm(access.tempDir, { recursive: true, force: true });
      }
    });
  });

  it("rejects an unsafe preexisting private temp directory rather than repairing it", async () => {
    await withTempDir({ prefix: "openclaw-outbound-private-" }, async (root) => {
      const backend = createShellBackend(root);
      const bridge = createBridge();
      const params = { backend, bridge, scopeKey: "one", workspaceDir: "/gateway/one" };
      const access = await createSandboxOutboundFileAccess(params);
      try {
        await fs.chmod(access.tempDir, 0o755);
        await expect(createSandboxOutboundFileAccess(params)).rejects.toThrow(/mode 0700/u);
        await fs.rm(access.tempDir, { recursive: true });
        await fs.symlink(root, access.tempDir);
        await expect(createSandboxOutboundFileAccess(params)).rejects.toThrow();
      } finally {
        await fs.rm(access.tempDir, { recursive: true, force: true });
      }
    });
  });

  it("checks current owner authority before reading and again after awaited reads", async () => {
    await withTempDir({ prefix: "openclaw-outbound-authority-" }, async (root) => {
      const assertCurrentAuthority = vi.fn(async () => {});
      const backend = { ...createShellBackend(root), assertCurrentAuthority };
      const bridge = createBridge();
      const access = await createSandboxOutboundFileAccess({
        backend,
        bridge,
        scopeKey: "one",
        workspaceDir: "/gateway/one",
      });
      try {
        expect(access.assertCurrentAuthority).toBe(assertCurrentAuthority);
        assertCurrentAuthority.mockRejectedValueOnce(new Error("authority changed before read"));
        await expect(access.readFile({ filePath: "report.txt", maxBytes: 100 })).rejects.toThrow(
          "authority changed before read",
        );
        expect(bridge.readFile).not.toHaveBeenCalled();
        assertCurrentAuthority
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("authority changed during read"));
        await expect(access.readFile({ filePath: "report.txt", maxBytes: 100 })).rejects.toThrow(
          "authority changed during read",
        );
        expect(bridge.readFile).toHaveBeenCalledOnce();
      } finally {
        await fs.rm(access.tempDir, { recursive: true, force: true });
      }
    });
  });

  it.runIf(process.geteuid?.() === 0)(
    "refuses synthetic files owned by another account even when readable",
    async () => {
      await withTempDir({ prefix: "openclaw-outbound-owner-" }, async (root) => {
        const backend = createShellBackend(root);
        const bridge = createBridge();
        const access = await createSandboxOutboundFileAccess({
          backend,
          bridge,
          scopeKey: "one",
          workspaceDir: "/gateway/one",
        });
        try {
          const file = path.join(root, "foreign-fixture.txt");
          await fs.writeFile(file, "synthetic fixture", { mode: 0o644 });
          await fs.chown(file, 65534, 65534);
          await expect(access.readFile({ filePath: file, maxBytes: 100 })).rejects.toThrow(
            /belong to the runtime account/u,
          );
          expect(bridge.readFile).not.toHaveBeenCalled();
        } finally {
          await fs.rm(access.tempDir, { recursive: true, force: true });
        }
      });
    },
  );
});
