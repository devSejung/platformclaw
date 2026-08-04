import { describe, expect, it, vi } from "vitest";
import { applyPatch } from "./apply-patch.test-support.js";

describe("applyPatch sandbox bridge", () => {
  it("uses container paths when the sandbox bridge has no local host path", async () => {
    const files = new Map<string, string>([["/sandbox/source.txt", "before\n"]]);
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        relativePath: filePath,
        containerPath: `/sandbox/${filePath}`,
      }),
      readFile: vi.fn(async ({ filePath }: { filePath: string }) =>
        Buffer.from(files.get(filePath) ?? "", "utf8"),
      ),
      writeFile: vi.fn(async ({ filePath, data }: { filePath: string; data: Buffer | string }) => {
        files.set(filePath, Buffer.isBuffer(data) ? data.toString("utf8") : data);
      }),
      remove: vi.fn(async ({ filePath }: { filePath: string }) => {
        files.delete(filePath);
      }),
      mkdirp: vi.fn(async () => {}),
    };

    const patch = `*** Begin Patch
*** Update File: source.txt
@@
-before
+after
*** End Patch`;

    const result = await applyPatch(patch, {
      cwd: "/local/workspace",
      sandbox: {
        root: "/local/workspace",
        containerRoot: "/sandbox",
        bridge: bridge as never,
      },
    });

    expect(files.get("/sandbox/source.txt")).toBe("after\n");
    expect(result.summary.modified).toEqual(["source.txt"]);
    expect(bridge.readFile).toHaveBeenCalledWith({
      filePath: "/sandbox/source.txt",
      cwd: "/local/workspace",
    });
  });

  it("rejects a remote home alias when apply_patch is workspace-only", async () => {
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        relativePath: filePath,
        containerPath: `/workspace/${filePath}`,
      }),
      resolveUserPath: ({ filePath }: { filePath: string }) => ({
        relativePath: filePath,
        containerPath: filePath.startsWith("~/")
          ? `/users/worker/${filePath.slice(2)}`
          : `/workspace/${filePath}`,
      }),
    };
    const patch = `*** Begin Patch
*** Add File: ~/outside.txt
+blocked
*** End Patch`;

    await expect(
      applyPatch(patch, {
        cwd: "/local/workspace",
        sandbox: {
          root: "/local/workspace",
          containerRoot: "/workspace",
          bridge: bridge as never,
        },
      }),
    ).rejects.toThrow(/Path escapes sandbox root/);
  });
});
