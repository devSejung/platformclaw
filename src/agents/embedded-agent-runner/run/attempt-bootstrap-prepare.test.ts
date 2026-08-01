import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SandboxContext } from "../../sandbox/types.js";
import { loadProjectAgentsFile } from "./project-agents-file.js";

describe("split-workspace project instructions", () => {
  it("loads AGENTS.md through the active execution filesystem bridge", async () => {
    const stat = vi.fn(async () => ({ type: "file" as const, size: 9, mtimeMs: 1 }));
    const readFile = vi.fn(async () => Buffer.from("vm policy"));
    const sandbox = {
      containerWorkdir: "/home/user/project",
      backend: { capabilities: { separateAgentWorkspace: true } },
      fsBridge: { stat, readFile },
    } as unknown as SandboxContext;

    await expect(
      loadProjectAgentsFile({ sandbox, logicalWorkspaceDir: "/gateway/agent" }),
    ).resolves.toEqual({
      name: "AGENTS.md",
      path: path.join("/gateway/agent", "AGENTS.md"),
      content: "vm policy",
      missing: false,
    });
    expect(stat).toHaveBeenCalledWith({ filePath: "/home/user/project/AGENTS.md" });
    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/home/user/project/AGENTS.md" }),
    );
  });

  it("never falls back to Gateway AGENTS.md when the project file is absent", async () => {
    const sandbox = {
      containerWorkdir: "/project",
      backend: { capabilities: { separateAgentWorkspace: true } },
      fsBridge: { stat: vi.fn(async () => null) },
    } as unknown as SandboxContext;

    await expect(
      loadProjectAgentsFile({ sandbox, logicalWorkspaceDir: "/gateway/agent" }),
    ).resolves.toMatchObject({ name: "AGENTS.md", missing: true });
  });
});
