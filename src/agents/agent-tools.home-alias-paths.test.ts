import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { wrapToolWorkspaceRootGuardWithOptions } from "./agent-tools.read.js";
import type { SandboxContext } from "./sandbox.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";
import {
  createSandboxFsTools,
  expectReadWriteEditTools,
} from "./test-helpers/agent-tools-fs-helpers.js";

describe("sandbox backend home aliases", () => {
  it("edits a home alias outside the workspace when workspace-only policy is disabled", async () => {
    const root = path.resolve("/local/workspace");
    const target = "/users/worker/projects/demo/source.txt";
    let persisted = "before\n";
    const writeFile = vi.fn(async ({ data }: { data: string }) => {
      persisted = data;
    });
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        relativePath: filePath,
        containerPath: filePath,
      }),
      resolveUserPath: ({ filePath }: { filePath: string }) => ({
        relativePath: filePath,
        containerPath: filePath.startsWith("~/")
          ? `/users/worker/${filePath.slice(2)}`
          : `/users/worker/.platformclaw/workspace/${filePath}`,
      }),
      stat: vi.fn(async ({ filePath }: { filePath: string }) =>
        filePath === target
          ? { type: "file" as const, size: Buffer.byteLength(persisted), mtimeMs: 0 }
          : null,
      ),
      readFile: vi.fn(async ({ filePath }: { filePath: string }) =>
        Buffer.from(filePath === target ? persisted : "", "utf8"),
      ),
      writeFile,
    } as unknown as SandboxFsBridge;
    const sandbox = {
      workspaceDir: root,
      fsBridge: bridge,
    } as unknown as SandboxContext;
    const { editTool } = expectReadWriteEditTools(
      createSandboxFsTools({ sandbox, workspaceOnly: false }),
    );

    await editTool?.execute("edit-home-alias", {
      path: "~/projects/demo/source.txt",
      edits: [{ oldText: "before", newText: "after" }],
    });

    expect(writeFile).toHaveBeenCalledWith({ filePath: target, cwd: root, data: "after\n" });
  });

  it("guards home aliases after resolving them to remote container paths", async () => {
    const root = path.resolve("/local/workspace");
    const execute = vi.fn(async () => ({ content: [] }));
    const guarded = wrapToolWorkspaceRootGuardWithOptions(
      { name: "read", execute } as never,
      root,
      {
        containerWorkdir: "/users/worker/.platformclaw/workspace",
        resolveGuardPath: (filePath) =>
          filePath.startsWith("~/")
            ? `/users/worker/${filePath.slice(2)}`
            : `/users/worker/.platformclaw/workspace/${filePath}`,
      },
    );

    await expect(guarded.execute("home-alias", { path: "~/secret.txt" })).rejects.toThrow(
      /Path escapes sandbox root/i,
    );
    await expect(guarded.execute("workspace-relative", { path: "note.txt" })).resolves.toEqual({
      content: [],
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
