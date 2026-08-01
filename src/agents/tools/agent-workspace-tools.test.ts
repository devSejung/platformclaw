import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceStateSnapshot } from "../workspace-state-store.js";
import { createAgentWorkspaceTools } from "./agent-workspace-tools.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workspace-tools-"));
  dirs.push(dir);
  return dir;
}

function tool(dir: string, name: string) {
  const found = createAgentWorkspaceTools(dir).find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`missing ${name}`);
  }
  return found;
}

describe("Agent workspace tools", () => {
  it("reads, writes, and edits only closed-enum Agent files", async () => {
    const dir = await workspace();
    await tool(dir, "agent_workspace_write").execute("write", {
      file: "USER.md",
      content: "Name: old",
    });
    await tool(dir, "agent_workspace_edit").execute("edit", {
      file: "USER.md",
      old_text: "old",
      new_text: "new",
    });
    const result = await tool(dir, "agent_workspace_read").execute("read", {
      file: "USER.md",
    });
    expect(result.content).toEqual([{ type: "text", text: "Name: new" }]);
    await expect(
      tool(dir, "agent_workspace_write").execute("escape", {
        file: "AGENTS.md",
        content: "wrong owner",
      }),
    ).rejects.toThrow("file must be one of");
  });

  it("persists completion before removing BOOTSTRAP.md and is idempotent", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "BOOTSTRAP.md"), "ritual");
    const complete = tool(dir, "bootstrap_complete");
    await complete.execute("complete-1", {});
    await complete.execute("complete-2", {});

    expect(readWorkspaceStateSnapshot(dir).setup.setupCompletedAt).toBeTruthy();
    await expect(fs.stat(path.join(dir, "BOOTSTRAP.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
