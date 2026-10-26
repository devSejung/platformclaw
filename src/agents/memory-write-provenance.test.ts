import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";

describe("memory write provenance", () => {
  it("refuses mutations when the backend cannot resolve a host provenance path", async () => {
    const observer = createMemoryWriteProvenanceObserver({
      mutationRoot: process.cwd(),
      workspaceDir: process.cwd(),
      resolveMutationPath: () => undefined,
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
      "Memory write provenance requires a host-backed workspace.",
    );
    expect(writeFile).not.toHaveBeenCalled();
    await expect(operations.remove("/remote/workspace/MEMORY.md")).rejects.toThrow(
      "Memory write provenance requires a host-backed workspace.",
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
      expect(observer?.classifies(path.join(root, "alias", "new", "nested", "note.md"))).toBe(true);
      expect(observer?.classifies(path.join(root, "reports", "new", "report.txt"))).toBe(false);
      expect(observer?.classifies(path.join(root, "..", "outside", "memory", "note.md"))).toBe(
        false,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
