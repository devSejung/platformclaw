import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePatchFileOps } from "./apply-patch-file-ops.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";

describe("memory write provenance", () => {
  it.skipIf(process.platform === "win32").each([false, true])(
    "clears only a deleted host alias with workspaceOnly=%s",
    async (workspaceOnly) => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "memory-unlink-")));
      try {
        await fs.mkdir(path.join(root, "memory"));
        const target = path.join(root, "memory/note.md");
        const alias = path.join(root, "memory/alias.md");
        await fs.writeFile(target, "keep quarantined memory");
        await fs.symlink("note.md", alias);
        const clearWriteProvenance = vi.fn(async () => {});
        const observer = createMemoryWriteProvenanceObserver({
          mutationRoot: root,
          workspaceDir: root,
          plan: { recordWriteProvenance: async () => {}, clearWriteProvenance },
          resolveOriginClass: () => "untrusted",
        });
        const operations = resolvePatchFileOps({
          cwd: root,
          workspaceOnly,
          memoryWriteProvenance: observer,
        });
        await operations.remove(alias);
        expect(clearWriteProvenance).toHaveBeenCalledExactlyOnceWith({
          workspaceDir: root,
          relativePath: "memory/alias.md",
        });
        expect(await fs.readFile(target, "utf8")).toBe("keep quarantined memory");
        await expect(fs.lstat(alias)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
  it("refuses mutations when the backend cannot resolve provenance", async () => {
    const observer = createMemoryWriteProvenanceObserver({
      mutationRoot: process.cwd(),
      workspaceDir: process.cwd(),
      resolveRelativePath: async () => {
        throw new Error("backend unavailable");
      },
      plan: { recordWriteProvenance: async () => {} },
      resolveOriginClass: () => "untrusted",
    });
    const writeFile = vi.fn<(absolutePath: string, content: string) => Promise<void>>(
      async () => {},
    );
    const remove = vi.fn<(absolutePath: string) => Promise<void>>(async () => {});
    const operations = withMemoryWriteProvenance(
      {
        readFile: async () => Buffer.from(""),
        writeFile,
        remove,
      },
      observer,
    );
    await expect(operations.writeFile("/remote/workspace/MEMORY.md", "untrusted")).rejects.toThrow(
      "backend unavailable",
    );
    expect(writeFile).not.toHaveBeenCalled();
    await expect(operations.remove("/remote/workspace/MEMORY.md")).rejects.toThrow(
      "backend unavailable",
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it("classifies new nested files through existing symlink ancestors", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "memory-provenance-")));
    try {
      await fs.mkdir(path.join(root, "memory"));
      await fs.symlink(path.join(root, "memory"), path.join(root, "alias"), "junction");
      const observer = createMemoryWriteProvenanceObserver({
        mutationRoot: root,
        workspaceDir: root,
        plan: { recordWriteProvenance: async () => {} },
        resolveOriginClass: () => "agent",
      });
      expect(await observer?.classifies(path.join(root, "alias", "new", "nested", "note.md"))).toBe(
        true,
      );
      expect(await observer?.classifies(path.join(root, "reports", "new", "report.txt"))).toBe(
        false,
      );
      expect(
        await observer?.classifies(path.join(root, "..", "outside", "memory", "note.md")),
      ).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("allows runtime-only scratch paths without recording workspace memory", async () => {
    const recordWriteProvenance = vi.fn(async () => {});
    const observer = createMemoryWriteProvenanceObserver({
      mutationRoot: process.cwd(),
      workspaceDir: process.cwd(),
      resolveRelativePath: async () => undefined,
      plan: { recordWriteProvenance },
      resolveOriginClass: () => "untrusted",
    });
    const writeFile = vi.fn<(filePath: string, content: string) => Promise<void>>(async () => {});
    const operations = withMemoryWriteProvenance(
      { readFile: async () => Buffer.from(""), writeFile },
      observer,
    );
    await operations.writeFile("/tmp/note.md", "scratch");
    expect(writeFile).toHaveBeenCalledWith("/tmp/note.md", "scratch");
    expect(recordWriteProvenance).not.toHaveBeenCalled();
  });

  it("pins the memory identity before deleting and never resolves after the effect", async () => {
    let deleted = false;
    const resolveRelativePath = vi.fn(async () => {
      if (deleted) {
        throw new Error("path no longer exists");
      }
      return "memory/note.md";
    });
    const clearWriteProvenance = vi.fn(async () => {});
    const observer = createMemoryWriteProvenanceObserver({
      mutationRoot: process.cwd(),
      workspaceDir: process.cwd(),
      resolveRelativePath,
      plan: { recordWriteProvenance: async () => {}, clearWriteProvenance },
      resolveOriginClass: () => "untrusted",
    });
    await observer?.remove({
      absolutePath: "/workspace/alias/note.md",
      commit: async () => {
        deleted = true;
      },
    });
    expect(resolveRelativePath).toHaveBeenCalledOnce();
    expect(clearWriteProvenance).toHaveBeenCalledWith({
      workspaceDir: process.cwd(),
      relativePath: "memory/note.md",
    });
  });

  it("rolls provenance back when the filesystem write fails", async () => {
    let provenance = "before";
    const observer = createMemoryWriteProvenanceObserver({
      mutationRoot: process.cwd(),
      workspaceDir: process.cwd(),
      plan: {
        recordWriteProvenance: async () => {
          provenance = "predicted";
          return async () => {
            provenance = "before";
          };
        },
      },
      resolveOriginClass: () => "untrusted",
      now: () => 1,
    });
    const commit = vi.fn(async () => {
      throw new Error("disk full");
    });

    await expect(
      observer?.write({
        absolutePath: `${process.cwd()}/MEMORY.md`,
        contentBefore: "before",
        contentAfter: "after",
        commit,
      }),
    ).rejects.toThrow("disk full");
    expect(provenance).toBe("before");
    expect(commit).toHaveBeenCalledOnce();
  });
});
