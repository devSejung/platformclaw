import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlan,
} from "../plugins/memory-state.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendHandle,
} from "./sandbox/backend-handle.types.js";
import { createSandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";

function runShellCommand(
  params: SandboxBackendCommandParams,
): Promise<SandboxBackendCommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/bin/sh",
      ["-c", params.script, "openclaw-basic-workspace-test", ...(params.args ?? [])],
      { encoding: "buffer", maxBuffer: params.maxBufferBytes, signal: params.signal },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== "number" || !params.allowFailure)) {
          reject(new Error(stderr.toString("utf8").trim() || error.message, { cause: error }));
          return;
        }
        resolve({ stdout, stderr, code: typeof error?.code === "number" ? error.code : 0 });
      },
    );
    child.stdin?.end(params.stdin);
  });
}

// Basic execution enables account-owned scratch paths, which selects the real
// shell filesystem bridge even for workspace files. Keep provenance enabled.
describe.skipIf(process.platform !== "linux")("Basic workspace file provenance", () => {
  const roots: string[] = [];
  afterEach(async () => {
    clearMemoryPluginState();
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function createFixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "basic-provenance-")));
    roots.push(root);
    const gatewayWorkspace = path.join(root, "gateway");
    const runtimeWorkspace = path.join(root, "workspace");
    const scratch = path.join(root, "scratch");
    await Promise.all(
      [gatewayWorkspace, runtimeWorkspace, scratch].map((dir) => fs.mkdir(dir, { mode: 0o700 })),
    );
    const rollback = vi.fn<() => Promise<void>>(async () => {});
    const recordWriteProvenance = vi.fn<NonNullable<MemoryFlushPlan["recordWriteProvenance"]>>(
      async () => rollback,
    );
    const clearWriteProvenance = vi.fn<NonNullable<MemoryFlushPlan["clearWriteProvenance"]>>(
      async () => {},
    );
    registerMemoryCapability("memory-core", {
      flushPlanResolver: () => ({
        softThresholdTokens: 1,
        forceFlushTranscriptBytes: 1,
        reserveTokensFloor: 1,
        prompt: "flush",
        systemPrompt: "flush",
        relativePath: "memory/note.md",
        recordWriteProvenance,
        clearWriteProvenance,
      }),
    });
    const backend: SandboxBackendHandle = {
      id: "basic-shell-test",
      runtimeId: root,
      runtimeLabel: "Basic shell fixture",
      workdir: runtimeWorkspace,
      capabilities: { temporaryFiles: true },
      buildExecSpec: async ({ command, env }) => ({
        argv: ["/bin/sh", "-c", command],
        env,
        stdinMode: "pipe-closed",
      }),
      runShellCommand,
    };
    const sandbox = {
      ...createAgentToolsSandboxContext({
        workspaceDir: gatewayWorkspace,
        containerWorkdir: runtimeWorkspace,
      }),
      backend,
      accountOwnedRoots: ["/tmp"],
    };
    const bridge = createSandboxFsBridge({ sandbox });
    sandbox.fsBridge = bridge;
    expect(
      bridge.resolvePath({ filePath: `${runtimeWorkspace}/report.txt` }).hostPath,
    ).toBeUndefined();
    expect(bridge.resolvePath({ filePath: `${scratch}/report.txt` }).hostPath).toBeUndefined();
    const tools = createOpenClawCodingTools({
      workspaceDir: gatewayWorkspace,
      sandbox,
      config: { tools: { fs: { workspaceOnly: false } } },
      isTurnTainted: () => true,
    });
    const execute = async (name: string, args: unknown) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`Missing tool: ${name}`);
      }
      return await tool.execute(`basic-${name}`, args);
    };
    return {
      gatewayWorkspace,
      runtimeWorkspace,
      scratch,
      bridge,
      execute,
      rollback,
      recordWriteProvenance,
      clearWriteProvenance,
    };
  }

  it.each(["workspace", "scratch"])("writes and reads a %s file", async (target) => {
    const fixture = await createFixture();
    const directory = target === "workspace" ? fixture.runtimeWorkspace : fixture.scratch;
    const filePath = path.join(directory, "new", "report.txt");
    await fixture.execute("write", { path: filePath, content: "written body\n" });
    const read = await fixture.execute("read", { path: filePath });
    expect(JSON.stringify(read.content)).toContain("written body");
    expect(await fs.readFile(filePath, "utf8")).toBe("written body\n");
    expect(fixture.recordWriteProvenance).not.toHaveBeenCalled();
    expect(await fs.readdir(fixture.gatewayWorkspace)).toEqual([]);
  });

  it.each(["workspace", "scratch"])(
    "edits an independently shell-created %s file",
    async (target) => {
      const fixture = await createFixture();
      const directory = target === "workspace" ? fixture.runtimeWorkspace : fixture.scratch;
      const filePath = path.join(directory, "seeded.txt");
      await runShellCommand({ script: 'printf "%s" "$2" > "$1"', args: [filePath, "before\n"] });
      await fixture.execute("edit", {
        path: filePath,
        edits: [{ oldText: "before", newText: "after" }],
      });
      const read = await fixture.execute("read", { path: filePath });
      expect(JSON.stringify(read.content)).toContain("after");
      expect(await fs.readFile(filePath, "utf8")).toBe("after\n");
      expect(fixture.recordWriteProvenance).not.toHaveBeenCalled();
    },
  );

  it("records canonical memory paths through a parent alias without following the final entry", async () => {
    const fixture = await createFixture();
    const memoryDir = path.join(fixture.runtimeWorkspace, "memory");
    await fs.mkdir(memoryDir);
    await fs.symlink("memory", path.join(fixture.runtimeWorkspace, "alias"));
    const filePath = path.join(fixture.runtimeWorkspace, "alias", "note.md");
    await fixture.execute("write", { path: filePath, content: "untrusted memory\n" });
    expect(fixture.recordWriteProvenance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceDir: fixture.gatewayWorkspace,
        relativePath: "memory/note.md",
        contentBefore: "",
        contentAfter: "untrusted memory\n",
        originClass: "untrusted",
      }),
    );
    const target = path.join(fixture.runtimeWorkspace, "report.txt");
    const link = path.join(memoryDir, "link.md");
    await fs.writeFile(target, "keep report\n");
    await fs.symlink("../report.txt", link);
    await expect(fixture.bridge.resolveWorkspaceRelativePath?.({ filePath: link })).resolves.toBe(
      "memory/link.md",
    );
    await fixture.execute("apply_patch", {
      input: `*** Begin Patch\n*** Delete File: ${link}\n*** End Patch`,
    });
    expect(fixture.clearWriteProvenance).toHaveBeenCalledWith({
      workspaceDir: fixture.gatewayWorkspace,
      relativePath: "memory/link.md",
    });
    expect(await fs.readFile(target, "utf8")).toBe("keep report\n");
    await expect(fs.lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back an exclusive-create collision and clears the deleted memory entry", async () => {
    const fixture = await createFixture();
    const filePath = path.join(fixture.runtimeWorkspace, "memory", "nested", "patch.md");
    const patch = `*** Begin Patch\n*** Add File: ${filePath}\n+patched\n*** End Patch`;
    await fixture.execute("apply_patch", { input: patch });
    expect(fixture.recordWriteProvenance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        relativePath: "memory/nested/patch.md",
        contentBefore: "",
        contentAfter: "patched\n",
        originClass: "untrusted",
      }),
    );
    await expect(fixture.execute("apply_patch", { input: patch })).rejects.toThrow(
      /already exists/u,
    );
    expect(fixture.rollback).toHaveBeenCalledOnce();
    expect(await fs.readFile(filePath, "utf8")).toBe("patched\n");
    await fixture.execute("apply_patch", {
      input: `*** Begin Patch\n*** Delete File: ${filePath}\n*** End Patch`,
    });
    expect(fixture.clearWriteProvenance).toHaveBeenCalledExactlyOnceWith({
      workspaceDir: fixture.gatewayWorkspace,
      relativePath: "memory/nested/patch.md",
    });
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
