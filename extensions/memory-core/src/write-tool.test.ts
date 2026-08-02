import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryWriteTool } from "./write-tool.js";

describe("memory_write", () => {
  it("appends only to canonical MEMORY.md", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-write-"));
    try {
      const tool = createMemoryWriteTool({ workspaceDir });
      await tool.execute("one", { content: "Prefers concise answers." });
      await tool.execute("two", { content: "Project decision: no mirroring." });
      await expect(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).resolves.toContain(
        "Prefers concise answers.\n\nProject decision: no mirroring.",
      );
      await expect(fs.stat(path.join(workspaceDir, "memory"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
