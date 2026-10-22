import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { readSessionToolVisibilityRestrictions } from "openclaw/plugin-sdk/session-visibility";
import { describe, expect, it, vi } from "vitest";
import type { WikiHubMemoryClient } from "./client.js";
import { registerSpaceTools } from "./space-tools.js";
describe("Space recall tools", () => {
  it.each([0, 1])("preserves bounded recovery guidance for recall tool %s", async (toolIndex) => {
    const registerTool = vi.fn();
    const failure = {
      code: "space-conflict",
      error: "Page changed",
      action: "Restart the page read at bodyOffset 0 without pageRevision.",
    };
    const spaceRead = vi.fn().mockRejectedValue(
      Object.assign(new Error(failure.error), {
        memoryCorpusFailure: { ...failure, internal: "private-service-details" },
      }),
    );
    registerSpaceTools(
      {
        registerTool,
        runContext: { resolveAdmissionId: () => "admission" },
        on: vi.fn(),
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const tool = registerTool.mock.calls[toolIndex]![0]({ agentId: "person-a" });
    const result = await tool.execute("call", {});
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ status: "error", ...failure }) }],
      details: { status: "error", ...failure },
    });
    spaceRead.mockRejectedValueOnce(
      Object.assign(new Error("bounded service failure"), {
        memoryCorpusFailure: { ...failure, error: "x".repeat(600), action: "y".repeat(600) },
      }),
    );
    const bounded = await tool.execute("bounded", {});
    expect(bounded.details.error).toHaveLength(500);
    expect(bounded.details.action).toHaveLength(500);
  });

  it.each([0, 1])("redacts unexpected service failures for recall tool %s", async (toolIndex) => {
    const registerTool = vi.fn();
    const spaceRead = vi
      .fn()
      .mockRejectedValue(new Error("connect /private/service/socket token=secret"));
    registerSpaceTools(
      {
        registerTool,
        runContext: { resolveAdmissionId: () => "admission" },
        on: vi.fn(),
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const tool = registerTool.mock.calls[toolIndex]![0]({ agentId: "person-a" });
    const result = await tool.execute("call", {});
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({
      status: "error",
      error: "Space service is unavailable",
      action:
        "Retry the Space request. If it keeps failing, ask an administrator to check the Space service.",
    });
    expect(JSON.stringify(result)).not.toMatch(/private|socket|secret/);
  });

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
        authorName: { type: "string", minLength: 1, maxLength: 240 },
        authorId: { type: "string", minLength: 1, maxLength: 128 },
        spaceId: { type: "string", maxLength: 128 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        cursor: { type: "string", maxLength: 32 },
      },
      required: [],
      additionalProperties: false,
    });
    const get = registerTool.mock.calls[1]![0]({ agentId: "person-a", runId: "run-a" });
    expect(get.parameters).toEqual({
      type: "object",
      properties: {
        spaceId: { type: "string", maxLength: 128 },
        pageId: { type: "string", maxLength: 128 },
        view: { type: "string", enum: ["page", "qa"] },
        postId: { type: "string", minLength: 1, maxLength: 128 },
        qaCursor: { type: "string", maxLength: 512 },
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
    await search.execute("author-discovery", { authorName: "승언" });
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: "person-a",
      runId: "admission-a",
      operation: "search",
      authorName: "승언",
      sessionKey,
    });
    await search.execute("author-topic", { authorId: "author-b", query: "PMIC" });
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: "person-a",
      runId: "admission-a",
      operation: "search",
      authorId: "author-b",
      query: "PMIC",
      sessionKey,
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
  it.each(["before_agent_run", "before_tool_call", "after_tool_approval"])(
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

  it("rechecks a resumed approval with the original ingress admission identity", async () => {
    const on = vi.fn();
    const admissionId = "knox-my:11111111-1111-1111-1111-111111111111";
    const resolveAdmissionId = vi.fn((context: { runId?: string }) =>
      context.runId === "native-old-run" ? admissionId : context.runId,
    );
    const spaceRead = vi
      .fn()
      .mockRejectedValueOnce(new Error("Knox request is no longer authorized"))
      .mockResolvedValueOnce({});
    registerSpaceTools(
      {
        registerTool: vi.fn(),
        runContext: { resolveAdmissionId },
        on,
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const afterApproval = on.mock.calls.find(([name]) => name === "after_tool_approval")![1];
    const context = {
      agentId: "person-alice",
      sessionKey: "agent:person-alice:space-session:22222222-2222-2222-2222-222222222222",
      runId: "native-old-run",
    };
    // The control plane's durable revoked receipt still denies the old admission
    // even when its employee has since rejoined; a new independent web run is checked separately.
    await expect(afterApproval({ approvalId: "approval-old" }, context)).rejects.toThrow(
      "no longer authorized",
    );
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      operation: "context",
      runId: admissionId,
    });
    await expect(
      afterApproval({ approvalId: "approval-web" }, { ...context, runId: "new-web-run" }),
    ).resolves.toBeUndefined();
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      operation: "context",
      runId: "new-web-run",
    });
  });

  it("retains Knox personal exec approvals in the admitted owner turn even when the model opts out", async () => {
    const on = vi.fn();
    const admissionId = "knox-my:11111111-1111-1111-1111-111111111111";
    const spaceRead = vi.fn(async () => ({}));
    registerSpaceTools(
      {
        registerTool: vi.fn(),
        runContext: { resolveAdmissionId: (context: { runId?: string }) => context.runId },
        on,
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const beforeTool = on.mock.calls.find(([name]) => name === "before_tool_call")![1];
    const params = { command: "echo ready", required: false, timeout: 30 };
    const context = {
      agentId: "person-alice",
      runId: admissionId,
      sessionKey: "agent:person-alice:space-session:22222222-2222-2222-2222-222222222222",
      channelId: "knox",
      requester: { senderId: "raw.knox.author" },
      originatingTo: "room:original-group",
    };
    const result = await beforeTool({ toolName: "exec", params }, context);
    expect(result).toEqual({ params: { ...params, required: true } });
    expect(params.required).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/original-group|raw\.knox\.author|space-session/);
    expect(spaceRead).toHaveBeenCalledWith({
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      operation: "context",
      runId: admissionId,
    });
    expect(
      await beforeTool({ toolName: "exec", params }, { ...context, runId: "independent-web-run" }),
    ).toBeUndefined();
    spaceRead.mockClear();
    expect(
      await beforeTool(
        { toolName: "exec", params },
        { ...context, sessionKey: "agent:group-original:main", runId: "knox:ordinary-message" },
      ),
    ).toBeUndefined();
    expect(spaceRead).not.toHaveBeenCalled();
    expect(params.required).toBe(false);
  });
  it.each([
    ...[
      "conversations_send",
      "conversations_turn",
      "openclaw",
      "sessions_send",
      "sessions_spawn",
    ].map((toolName) => ({ toolName, action: undefined, blocked: true })),
    ...["automations", "cron"].flatMap((toolName) => [
      ...["add", "update", "run", "wake"].map((action) => ({ toolName, action, blocked: true })),
      ...["get", "list", "remove", "runs", "status"].map((action) => ({
        toolName,
        action,
        blocked: false,
      })),
    ]),
    ...["image_generate", "music_generate", "video_generate"].flatMap((toolName) => [
      ...[undefined, "generate"].map((action) => ({ toolName, action, blocked: true })),
      ...["list", "status"].map((action) => ({ toolName, action, blocked: false })),
    ]),
    ...[undefined, "cancel", "list"].map((action) => ({
      toolName: "subagents",
      action,
      blocked: false,
    })),
    { toolName: "subagents", action: "steer", blocked: true },
    ...[
      "send",
      "broadcast",
      "reply",
      "thread-reply",
      "sendAttachment",
      "upload-file",
      "poll",
      "edit",
      "react",
      "delete",
      "future-publish",
    ].map((action) => ({ toolName: "message", action, blocked: true })),
    ...[
      "read",
      "search",
      "reactions",
      "list-pins",
      "permissions",
      "thread-list",
      "sticker-search",
      "member-info",
      "role-info",
      "emoji-list",
      "channel-info",
      "channel-list",
      "event-list",
      "download-file",
      "voice-status",
    ].map((action) => ({ toolName: "message", action, blocked: false })),
  ])(
    "keeps trusted /my $toolName action $action within its admitted request (blocked=$blocked)",
    async ({ toolName, action, blocked }) => {
      const on = vi.fn();
      const admissionId = "knox-my:11111111-1111-1111-1111-111111111111";
      const context = {
        agentId: "person-alice",
        sessionKey: "agent:person-alice:space-session:22222222-2222-2222-2222-222222222222",
        runId: "native-derived-run",
      };
      const resolveAdmissionId = vi.fn((input: { runId?: string }) =>
        input.runId === context.runId ? admissionId : input.runId,
      );
      const spaceRead = vi.fn(async () => ({}));
      registerSpaceTools(
        {
          registerTool: vi.fn(),
          on,
          runtime: { config: { current: () => ({}) } },
          runContext: { resolveAdmissionId },
          registerMemoryPromptSupplement: vi.fn(),
        } as unknown as OpenClawPluginApi,
        { spaceRead } as unknown as WikiHubMemoryClient,
      );
      const beforeTool = on.mock.calls.find(([name]) => name === "before_tool_call")![1];
      // Model arguments cannot opt a mapped /my run out of this policy.
      const params = { ...(action === undefined ? {} : { action }), runId: "independent-web-run" };
      const result = await beforeTool({ toolName, params }, context);

      expect(resolveAdmissionId).toHaveBeenCalledWith(context);
      expect(spaceRead).toHaveBeenCalledExactlyOnceWith({
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        operation: "context",
        runId: admissionId,
      });
      expect(result?.block === true).toBe(blocked);
      if (blocked) {
        expect(result.blockReason).toContain("cannot start detached work or publish directly");
      } else {
        expect(result).toBeUndefined();
      }
      expect(params.runId).toBe("independent-web-run");
    },
  );

  it.each([
    {
      sessionKey: "agent:person-alice:space-session:22222222-2222-2222-2222-222222222222",
      runId: "independent-web-run",
    },
    { sessionKey: "agent:group-original:main", runId: "knox:ordinary-message" },
  ])("keeps independent web/v1 publication unchanged for $runId", async (context) => {
    const on = vi.fn();
    const spaceRead = vi.fn(async () => ({}));
    registerSpaceTools(
      {
        registerTool: vi.fn(),
        on,
        runContext: { resolveAdmissionId: (input: { runId?: string }) => input.runId },
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const beforeTool = on.mock.calls.find(([name]) => name === "before_tool_call")![1];
    expect(
      await beforeTool(
        {
          toolName: "message",
          params: {
            action: "send",
            runId: "knox-my:model-forged-admission",
            sessionKey: "agent:person-alice:space-session:22222222-2222-2222-2222-222222222222",
          },
        },
        { agentId: "person-alice", ...context },
      ),
    ).toBeUndefined();
  });

  it("retains the original admission for native authorization from a derived run", async () => {
    const on = vi.fn();
    const admissionId = "knox-my:11111111-1111-1111-1111-111111111111";
    const context = {
      agentId: "person-alice",
      sessionKey: "agent:person-alice:space-session:22222222-2222-2222-2222-222222222222",
      runId: "native-derived-run",
    };
    const resolveAdmissionId = vi.fn((input: { runId?: string }) =>
      input.runId === context.runId ? admissionId : input.runId,
    );
    const spaceRead = vi.fn(async () => ({ sessionKey: context.sessionKey }));
    registerSpaceTools(
      {
        registerTool: vi.fn(),
        on,
        runtime: { config: { current: () => ({}) } },
        runContext: { resolveAdmissionId },
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const beforeTool = on.mock.calls.find(([name]) => name === "before_tool_call")![1];

    await beforeTool(
      { toolName: "session_status", params: { sessionKey: "current", runId: "model-forged-run" } },
      context,
    );

    expect(resolveAdmissionId).toHaveBeenCalledWith(context);
    expect(spaceRead).toHaveBeenNthCalledWith(1, {
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      operation: "context",
      runId: admissionId,
    });
    expect(spaceRead).toHaveBeenNthCalledWith(2, {
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      operation: "native",
      runId: admissionId,
      nativeTool: "session_status",
      nativeAction: "read",
      targetSessionKey: context.sessionKey,
      broad: false,
    });
  });

  it("authorizes native aliases through the service and rewrites only resolved selectors", async () => {
    const on = vi.fn();
    const canonical = "agent:person-a:space-session:11111111-1111-1111-1111-111111111111";
    const spaceRead = vi.fn(
      async (): Promise<{ sessionKey?: string; agentId?: string }> => ({ sessionKey: canonical }),
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
      runId: "admission",
      nativeTool: "sessions_send",
      targetLabel: "Earlier work",
      targetAgentId: "person-a",
      broad: false,
    });
    expect(allowed).toEqual({ params: { sessionKey: canonical, message: "Continue" } });
    spaceRead.mockClear();
    config = { tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } } };
    const list = await hook({ toolName: "sessions_list", params: {} }, context);
    expect(spaceRead).not.toHaveBeenCalled();
    expect(readSessionToolVisibilityRestrictions(list.params)).toEqual({
      denyKeyPatterns: ["agent:space-*-*-*-*-*:space:*"],
      denyKeySubstrings: [":space-session:"],
    });
    const listWithForgedSessionKey = await hook(
      { toolName: "sessions_list", params: { sessionKey: "agent:person-a:main" } },
      context,
    );
    expect(spaceRead).not.toHaveBeenCalled();
    expect(readSessionToolVisibilityRestrictions(listWithForgedSessionKey.params)).toEqual({
      denyKeyPatterns: ["agent:space-*-*-*-*-*:space:*"],
      denyKeySubstrings: [":space-session:"],
    });
    config = { tools: { sessions: { visibility: "agent" } } };
    const search = await hook({ toolName: "sessions_search", params: { query: "trace" } }, context);
    expect(spaceRead).not.toHaveBeenCalled();
    expect(readSessionToolVisibilityRestrictions(search.params)).toEqual({
      denyKeyPatterns: ["agent:space-*-*-*-*-*:space:*"],
      denyKeySubstrings: [":space-session:"],
    });
    const descendant = "agent:person-a:subagent:child";
    spaceRead.mockResolvedValueOnce({ sessionKey: descendant });
    const exactSearch = await hook(
      { toolName: "sessions_search", params: { query: "trace", sessionKey: descendant } },
      context,
    );
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: "person-a",
      sessionKey: context.sessionKey,
      operation: "native",
      runId: "admission",
      nativeTool: "sessions_search",
      targetSessionKey: descendant,
      broad: false,
    });
    expect(readSessionToolVisibilityRestrictions(exactSearch.params)).toEqual({
      denyKeyPatterns: ["agent:space-*-*-*-*-*:space:*"],
      denyKeySubstrings: [":space-session:"],
    });
    spaceRead.mockResolvedValueOnce({ sessionKey: "global", agentId: "person-a" });
    const exactHistory = await hook(
      { toolName: "sessions_history", params: { sessionKey: "global", includeTools: true } },
      context,
    );
    expect(exactHistory).toEqual({
      params: { sessionKey: "global", includeTools: true, agentId: "person-a" },
    });
    spaceRead.mockResolvedValueOnce({ sessionKey: "global" });
    const defaultHistory = await hook(
      {
        toolName: "sessions_history",
        params: { sessionKey: "agent:person-a:main", agentId: "person-b", includeTools: true },
      },
      context,
    );
    expect(defaultHistory).toEqual({ params: { sessionKey: "global", includeTools: true } });
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
      runId: "admission",
      nativeTool: "session_status",
      targetSessionKey: context.sessionKey,
      nativeAction: "patch",
      broad: false,
    });
    spaceRead.mockRejectedValueOnce(
      Object.assign(new Error("Space conversation unavailable"), {
        memoryCorpusFailure: {
          code: "space-forbidden",
          error: "Another member's raw Space session is private",
          action: "Use space_search for shared Q&A.",
        },
      }),
    );
    expect(
      await hook(
        {
          toolName: "sessions_history",
          params: { sessionKey: "opaque-peer-id", includeTools: true },
        },
        context,
      ),
    ).toEqual({
      block: true,
      blockReason: "Another member's raw Space session is private Use space_search for shared Q&A.",
    });
    expect(await hook({ toolName: "sessions_history", params: {} }, {})).toEqual({
      block: true,
      blockReason: "Session owner unavailable; retry in an authenticated personal session",
    });
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
      runId: "admission",
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
