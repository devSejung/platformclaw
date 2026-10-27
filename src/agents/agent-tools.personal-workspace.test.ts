import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../security/dangerous-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { AGENT_WORKSPACE_TOOL_NAMES } from "./tools/agent-workspace-tools.js";
import { readWorkspaceStateSnapshot } from "./workspace-state-store.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-agent-workspace-"));
  roots.push(root);
  const workspaceDir = path.join(root, "project");
  const agentWorkspaceDir = path.join(root, "agent");
  await Promise.all([fs.mkdir(workspaceDir), fs.mkdir(agentWorkspaceDir)]);
  const sandbox = createAgentToolsSandboxContext({
    workspaceDir,
    agentWorkspaceDir,
    fsBridge: createHostSandboxFsBridge(workspaceDir),
  });
  sandbox.backend = {
    id: "split-workspace-test",
    runtimeId: "split-workspace-test",
    runtimeLabel: "split-workspace-test",
    workdir: workspaceDir,
    capabilities: { separateAgentWorkspace: true },
    buildExecSpec: () => {
      throw new Error("unexpected shell execution");
    },
    runShellCommand: async () => {
      throw new Error("unexpected backend command");
    },
  };
  const tools = (
    senderAgentId: string | undefined,
    sessionKey = "agent:main:main",
    senderIsOwner = false,
  ) =>
    createOpenClawCodingTools({
      agentId: "main",
      config: { tools: { profile: "coding" } },
      workspaceDir: agentWorkspaceDir,
      sandbox,
      sessionKey,
      senderIsOwner,
      senderAgentId,
      wrapBeforeToolCallHook: false,
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });
  return { root, workspaceDir, agentWorkspaceDir, sandbox, tools };
}

function requireTool(tools: ReturnType<typeof createOpenClawCodingTools>, name: string) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`missing tool ${name}`);
  }
  return tool;
}

describe("personal Agent workspace authority", () => {
  it("allows the bound Agent profile and bootstrap without Gateway owner tools", async () => {
    const ctx = await fixture();
    const configPath = path.join(ctx.root, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(ctx.root, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(
      configPath,
      JSON.stringify({ agents: { entries: { main: { workspace: ctx.agentWorkspaceDir } } } }),
    );
    await fs.writeFile(path.join(ctx.agentWorkspaceDir, "BOOTSTRAP.md"), "finish setup");
    const tools = ctx.tools("main");
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...AGENT_WORKSPACE_TOOL_NAMES]),
    );
    expect(
      tools.filter((tool) => GATEWAY_OWNER_ONLY_CORE_TOOLS.some((name) => name === tool.name)),
    ).toEqual([]);
    const privilegedTools = (senderIsOwner: boolean) =>
      createOpenClawCodingTools({
        agentId: "main",
        workspaceDir: ctx.agentWorkspaceDir,
        sessionKey: "agent:main:main",
        config: { tools: { profile: "full" } },
        senderIsOwner,
        senderAgentId: "main",
        wrapBeforeToolCallHook: false,
      });
    expect(privilegedTools(true).some((tool) => tool.name === "gateway")).toBe(true);
    expect(
      privilegedTools(false).filter((tool) =>
        GATEWAY_OWNER_ONLY_CORE_TOOLS.some((name) => name === tool.name),
      ),
    ).toEqual([]);

    await requireTool(tools, "agent_workspace_write").execute("profile-write", {
      file: "USER.md",
      content: "Name: before",
    });
    await requireTool(tools, "agent_workspace_edit").execute("profile-edit", {
      file: "USER.md",
      old_text: "before",
      new_text: "after",
    });
    expect(
      await requireTool(tools, "agent_workspace_read").execute("profile-read", { file: "USER.md" }),
    ).toMatchObject({ content: [{ type: "text", text: "Name: after" }] });
    expect(await fs.readFile(path.join(ctx.agentWorkspaceDir, "USER.md"), "utf8")).toBe(
      "Name: after",
    );
    await expect(fs.access(path.join(ctx.workspaceDir, "USER.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      requireTool(tools, "agent_workspace_write").execute("foreign-path", {
        file: "../foreign/USER.md",
        content: "blocked",
      }),
    ).rejects.toThrow("file must be one of");
    await requireTool(tools, "agent_workspace_write").execute("identity-write", {
      file: "IDENTITY.md",
      content: "- Name: Personal Agent\n- Emoji: C\n",
    });
    await requireTool(tools, "bootstrap_complete").execute("bootstrap", {});
    expect(readWorkspaceStateSnapshot(ctx.agentWorkspaceDir).setup.setupCompletedAt).toBeTruthy();
    await expect(fs.access(path.join(ctx.agentWorkspaceDir, "BOOTSTRAP.md"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    expect(
      JSON.parse(await fs.readFile(configPath, "utf8")).agents.entries.main.identity.name,
    ).toBe("Personal Agent");
  });

  it.each([undefined, "foreign"])(
    "denies Agent workspace tools without the exact binding (%s)",
    async (senderAgentId) => {
      const ctx = await fixture();
      const names = ctx.tools(senderAgentId).map((tool) => tool.name);
      expect(
        names.filter((name) =>
          AGENT_WORKSPACE_TOOL_NAMES.some((workspaceTool) => workspaceTool === name),
        ),
      ).toEqual([]);
      expect(names).not.toContain("gateway");
    },
  );

  it.each(["agent:main:subagent:child", "agent:main:cron:job"])(
    "keeps delegated and scheduled exclusions for %s",
    async (sessionKey) => {
      const ctx = await fixture();
      const names = ctx.tools("main", sessionKey).map((tool) => tool.name);
      expect(
        names.filter((name) =>
          AGENT_WORKSPACE_TOOL_NAMES.some((workspaceTool) => workspaceTool === name),
        ),
      ).toEqual([]);
    },
  );
});
