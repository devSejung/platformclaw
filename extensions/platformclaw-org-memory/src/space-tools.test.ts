import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { WikiHubMemoryClient } from "./client.js";
import { registerSpaceTools } from "./space-tools.js";
describe("Space recall tools", () => {
  it("pins the trusted runtime actor/run and advertises only read operations", async () => {
    const registerTool = vi.fn();
    const resolveAdmissionId = vi.fn((context: { runId?: string }) =>
      context.runId === "run-a" ? "admission-a" : context.runId,
    );
    const spaceRead = vi.fn(async () => ({ results: [] }));
    registerSpaceTools(
      {
        registerTool,
        runContext: { resolveAdmissionId },
        on: vi.fn(),
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const sessionKey = "agent:person-a:space-session:11111111-1111-1111-1111-111111111111";
    const context = { agentId: "person-a", runId: "run-a", sessionKey };
    const search = registerTool.mock.calls[0]![0](context);
    await search.execute("call", {
      query: "timing",
      agentId: "forged-agent",
      operation: "context",
      runId: "forged-run",
      sessionKey: "agent:other:main",
    });
    expect(spaceRead).toHaveBeenCalledWith({
      agentId: "person-a",
      runId: "admission-a",
      operation: "search",
      query: "timing",
      sessionKey,
    });
    expect(resolveAdmissionId).toHaveBeenCalledWith(context);
    expect(search.parameters).toEqual({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1000 },
        spaceId: { type: "string", maxLength: 128 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        cursor: { type: "string", maxLength: 32 },
      },
      required: ["query"],
      additionalProperties: false,
    });
    const get = registerTool.mock.calls[1]![0]({ agentId: "person-a", runId: "run-a" });
    expect(get.parameters).toEqual({
      type: "object",
      properties: {
        spaceId: { type: "string", maxLength: 128 },
        pageId: { type: "string", maxLength: 128 },
        conversationId: { type: "string", maxLength: 128 },
        messageId: { type: "string", maxLength: 256 },
        bodyOffset: { type: "integer", minimum: 0, maximum: 32000 },
        pageRevision: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 8 },
        bodyLimitBytes: { type: "integer", minimum: 64, maximum: 8000 },
        messageOffset: { type: "integer", minimum: 0, maximum: 16000 },
      },
      required: ["spaceId", "pageId"],
      additionalProperties: false,
    });
    await get.execute("page-window", {
      spaceId: "space-a",
      pageId: "page-a",
      conversationId: "conversation-a",
      bodyOffset: 8000,
      pageRevision: 3,
    });
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: "person-a",
      runId: "admission-a",
      operation: "get",
      spaceId: "space-a",
      pageId: "page-a",
      conversationId: "conversation-a",
      bodyOffset: 8000,
      pageRevision: 3,
    });
    expect(search.parameters.properties.agentId).toBeUndefined();
    expect(search.parameters.properties.runId).toBeUndefined();
    expect(registerTool.mock.calls.map((call) => call[1].name)).toEqual([
      "space_search",
      "space_get",
    ]);
  });
  it("loads only registered personal Space context without replacing personal tools", async () => {
    const on = vi.fn();
    const spaceRead = vi.fn(async () => ({ spaceName: "Project", page: { title: "Issue" } }));
    registerSpaceTools(
      {
        registerTool: vi.fn(),
        runContext: { resolveAdmissionId: () => "admission" },
        on,
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const hook = on.mock.calls.find(([name]) => name === "before_prompt_build")![1];
    const context = {
      agentId: "person-alice",
      sessionKey: "agent:person-alice:space-session:11111111-1111-1111-1111-111111111111",
      runId: "run",
    };
    const result = await hook({}, context);
    expect(spaceRead).toHaveBeenCalledWith({
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      operation: "context",
      runId: "admission",
    });
    expect(result.prependContext).toContain("Project");
    expect(result.appendSystemContext).toContain("current employee alone owns execution");
    expect(result.toolsAllow).toBeUndefined();
    spaceRead.mockClear();
    expect(await hook({}, { ...context, sessionKey: "agent:person-alice:main" })).toBeUndefined();
    expect(spaceRead).not.toHaveBeenCalled();
  });
  it.each(["before_agent_run", "before_tool_call"])(
    "revalidates Space membership at %s and fails closed after revocation",
    async (hookName) => {
      const on = vi.fn();
      const spaceRead = vi.fn(async () => ({}));
      registerSpaceTools(
        {
          registerTool: vi.fn(),
          runContext: { resolveAdmissionId: () => "admission" },
          on,
          registerMemoryPromptSupplement: vi.fn(),
        } as unknown as OpenClawPluginApi,
        { spaceRead } as unknown as WikiHubMemoryClient,
      );
      const hook = on.mock.calls.find(([name]) => name === hookName)![1];
      const context = {
        agentId: "person-alice",
        sessionKey: "agent:person-alice:space-session:11111111-1111-1111-1111-111111111111",
        runId: "run",
      };
      await hook({ toolName: "exec" }, context);
      expect(spaceRead).toHaveBeenCalledWith({
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        operation: "context",
        runId: "admission",
      });
      spaceRead.mockRejectedValueOnce(new Error("Space unavailable"));
      await expect(hook({ toolName: "exec" }, context)).rejects.toThrow("Space unavailable");
      spaceRead.mockClear();
      await hook({ toolName: "exec" }, { ...context, sessionKey: "agent:person-alice:main" });
      expect(spaceRead).not.toHaveBeenCalled();
    },
  );
  it("authorizes native aliases through the service and rewrites only resolved selectors", async () => {
    const on = vi.fn();
    const canonical = "agent:person-a:space-session:11111111-1111-1111-1111-111111111111";
    const spaceRead = vi.fn(
      async (): Promise<{ sessionKey?: string }> => ({ sessionKey: canonical }),
    );
    let config = {};
    registerSpaceTools(
      {
        registerTool: vi.fn(),
        on,
        runtime: { config: { current: () => config } },
        runContext: { resolveAdmissionId: () => "admission" },
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const hook = on.mock.calls.find(([name]) => name === "before_tool_call")![1];
    const context = { agentId: "person-a", sessionKey: "agent:person-a:main" };
    const allowed = await hook(
      {
        toolName: "sessions_send",
        params: {
          label: "Earlier work",
          agentId: "person-a",
          message: "Continue",
        },
      },
      context,
    );
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: "person-a",
      sessionKey: context.sessionKey,
      operation: "native",
      nativeTool: "sessions_send",
      targetLabel: "Earlier work",
      targetAgentId: "person-a",
      broad: false,
    });
    expect(allowed).toEqual({ params: { sessionKey: canonical, message: "Continue" } });
    config = { tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } } };
    spaceRead.mockResolvedValueOnce({});
    await hook({ toolName: "sessions_list", params: {} }, context);
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: "person-a",
      sessionKey: context.sessionKey,
      operation: "native",
      nativeTool: "sessions_list",
      broad: true,
    });
    config = { tools: { sessions: { visibility: "agent" } } };
    spaceRead.mockResolvedValueOnce({});
    await hook({ toolName: "sessions_search", params: { query: "trace" } }, context);
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: "person-a",
      sessionKey: context.sessionKey,
      operation: "native",
      nativeTool: "sessions_search",
      targetAgentId: "person-a",
      broad: true,
    });
  });
  it("uses trusted current-session identity and blocks native reads when authorization fails", async () => {
    const on = vi.fn();
    const spaceRead = vi.fn(async () => ({}));
    registerSpaceTools(
      {
        registerTool: vi.fn(),
        on,
        runtime: { config: { current: () => ({}) } },
        runContext: { resolveAdmissionId: () => "admission" },
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const hook = on.mock.calls.find(([name]) => name === "before_tool_call")![1];
    const context = { agentId: "person-a", sessionKey: "agent:person-a:main" };
    await hook(
      { toolName: "session_status", params: { sessionKey: "current", model: "configured-model" } },
      context,
    );
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: "person-a",
      sessionKey: context.sessionKey,
      operation: "native",
      nativeTool: "session_status",
      targetSessionKey: context.sessionKey,
      nativeAction: "patch",
      broad: false,
    });
    spaceRead.mockRejectedValueOnce(new Error("Space conversation unavailable"));
    await expect(
      hook(
        {
          toolName: "sessions_history",
          params: { sessionKey: "opaque-peer-id", includeTools: true },
        },
        context,
      ),
    ).rejects.toThrow("Space conversation unavailable");
    await expect(hook({ toolName: "sessions_history", params: {} }, {})).rejects.toThrow(
      "Session owner unavailable",
    );
  });
  it.each([
    {
      name: "global collector default",
      config: { tools: { swarm: { defaultAgentId: "PERSON-B" } } },
      params: { collect: true },
      target: "person-b",
    },
    {
      name: "per-agent collector default",
      config: {
        tools: { swarm: { defaultAgentId: "person-b" } },
        agents: { entries: { "person-a": { tools: { swarm: { defaultAgentId: "worker" } } } } },
      },
      params: { collect: true },
      target: "worker",
    },
    {
      name: "explicit target",
      config: { tools: { swarm: { defaultAgentId: "person-b" } } },
      params: { collect: true, agentId: "WORKER" },
      target: "worker",
    },
    {
      name: "normal self spawn",
      config: { tools: { swarm: { defaultAgentId: "person-b" } } },
      params: {},
      target: "person-a",
    },
  ])("authorizes and pins $name before spawning", async ({ config, params, target }) => {
    const on = vi.fn();
    const spaceRead = vi.fn(async () => ({}));
    registerSpaceTools(
      {
        registerTool: vi.fn(),
        on,
        runtime: { config: { current: () => config } },
        runContext: { resolveAdmissionId: () => "admission" },
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const hook = on.mock.calls.find(([name]) => name === "before_tool_call")![1];
    const context = { agentId: "person-a", sessionKey: "agent:person-a:main" };
    expect(await hook({ toolName: "sessions_spawn", params }, context)).toEqual({
      params: { ...params, agentId: target },
    });
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: "person-a",
      sessionKey: context.sessionKey,
      operation: "native",
      nativeTool: "sessions_spawn",
      targetAgentId: target,
      broad: false,
    });
    spaceRead.mockRejectedValueOnce(new Error("Cannot run another employee's personal agent"));
    await expect(hook({ toolName: "sessions_spawn", params }, context)).rejects.toThrow(
      "Cannot run another employee",
    );
  });
});
