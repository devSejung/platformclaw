import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const configMocks = vi.hoisted(() => ({
  draft: {} as OpenClawConfig,
  mutateConfigFileWithRetry: vi.fn(async (params: { mutate: (draft: OpenClawConfig) => void }) =>
    params.mutate(configMocks.draft),
  ),
}));

vi.mock("../config/config.js", () => ({
  mutateConfigFileWithRetry: configMocks.mutateConfigFileWithRetry,
}));

const { syncAgentIdentityFromWorkspace } = await import("./bootstrap-identity.js");
const dirs: string[] = [];

afterEach(async () => {
  configMocks.draft = {};
  configMocks.mutateConfigFileWithRetry.mockClear();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function workspace(identity: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-identity-"));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, "IDENTITY.md"), identity);
  return dir;
}

describe("bootstrap identity sync", () => {
  it("persists parsed identity for only the selected Agent", async () => {
    const dir = await workspace(
      "# IDENTITY.md\n\n- Name: Claw\n- Creature: careful builder\n- Emoji: 🦞\n",
    );
    configMocks.draft = {
      agents: { list: [{ id: "alpha" }, { id: "beta", identity: { name: "Keep" } }] },
    };

    await syncAgentIdentityFromWorkspace({ agentId: "alpha", workspaceDir: dir });

    expect(configMocks.draft.agents?.entries).toEqual({
      alpha: { identity: { name: "Claw", theme: "careful builder", emoji: "🦞" } },
      beta: { identity: { name: "Keep" } },
    });
  });

  it("rejects an unfinished identity before writing config", async () => {
    const dir = await workspace("- Name: (not set yet)\n- Emoji: (pick something you like)\n");
    configMocks.draft = { agents: { list: [{ id: "alpha" }] } };

    await expect(
      syncAgentIdentityFromWorkspace({ agentId: "alpha", workspaceDir: dir }),
    ).rejects.toThrow("IDENTITY.md has no completed identity fields");
    expect(configMocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("rejects a mismatched Agent id", async () => {
    const dir = await workspace("- Name: Claw\n");
    configMocks.draft = { agents: { list: [{ id: "beta" }] } };

    await expect(
      syncAgentIdentityFromWorkspace({ agentId: "alpha", workspaceDir: dir }),
    ).rejects.toThrow('agent "alpha" not found');
  });
});
