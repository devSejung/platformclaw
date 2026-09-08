import { describe, expect, it, vi } from "vitest";
import {
  skillProposalInspectResult,
  skillProposalListResult,
} from "./browser-gateway-proxy.test-fixtures.js";
import {
  NOW,
  setupBrowserGatewayProxyTest as setup,
} from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy", () => {
  it("pins chat requests to the authenticated user's agent", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({ sessionKey: `agent:${binding.agentId}:main`, messages: [] });

    await proxy.request(token, "chat.history", {
      sessionKey: `agent:${binding.agentId}:main`,
      limit: 20,
    });

    expect(request).toHaveBeenCalledWith("chat.history", {
      agentId: binding.agentId,
      sessionKey: `agent:${binding.agentId}:main`,
      limit: 20,
    });
  });

  it("denies and audits cross-agent requests before Gateway dispatch", async () => {
    const { auditEvents, proxy, request, token, user, binding } = await setup();

    await expect(
      proxy.request(token, "chat.send", {
        agentId: "other",
        sessionKey: "agent:other:main",
        message: "hello",
        idempotencyKey: "request-1",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });

    expect(request).not.toHaveBeenCalled();
    expect(auditEvents).toEqual([
      expect.objectContaining({
        actorUserId: user.id,
        eventType: "browser.gateway.denied",
        targetId: binding.id,
        details: { method: "chat.send", reason: "cross-agent-denied" },
      }),
    ]);
  });

  it("denies operator methods that are absent from the explicit allowlist", async () => {
    const { proxy, request, token } = await setup();

    await expect(proxy.request(token, "config.get", {})).rejects.toMatchObject({
      code: "method-not-allowed",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("acknowledges the runtime-owned session event subscription locally", async () => {
    const { proxy, request, token } = await setup();

    await expect(proxy.request(token, "sessions.subscribe", {})).resolves.toEqual({
      subscribed: true,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("projects browser-safe agent rows and preserves scoped session pagination", async () => {
    const { binding, proxy, request, token } = await setup();
    request
      .mockResolvedValueOnce({
        defaultId: "other",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          {
            id: binding.agentId,
            name: "First User",
            workspace: "/srv/platformclaw/users/first",
            agentRuntime: { id: "internal-runtime", source: "agent" },
          },
          { id: "other" },
        ],
      })
      .mockResolvedValueOnce({
        total: 25,
        sessions: [{ key: `agent:${binding.agentId}:main`, agentId: binding.agentId }],
      });

    const agents = await proxy.request<{ agents: Array<Record<string, unknown>> }>(
      token,
      "agents.list",
      {},
    );
    expect(agents).toMatchObject({
      defaultId: binding.agentId,
      agents: [{ id: binding.agentId, name: "First User" }],
    });
    expect(agents.agents[0]).not.toHaveProperty("workspace");
    expect(agents.agents[0]).not.toHaveProperty("agentRuntime");
    await expect(
      proxy.request(token, "sessions.list", {
        boardFace: "dashboard",
        creatorId: "creator-1",
      }),
    ).resolves.toMatchObject({
      total: 25,
      sessions: [{ key: `agent:${binding.agentId}:main` }],
    });
    expect(request).toHaveBeenLastCalledWith("sessions.list", {
      boardFace: "dashboard",
      creatorId: "creator-1",
      agentId: binding.agentId,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
    });
  });

  it("filters chat startup agent metadata", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      sessionKey: `agent:${binding.agentId}:main`,
      messages: [],
      agentsList: {
        defaultId: "other",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: binding.agentId }, { id: "other" }],
      },
    });

    await expect(
      proxy.request(token, "chat.startup", { sessionKey: `agent:${binding.agentId}:main` }),
    ).resolves.toMatchObject({
      agentsList: { defaultId: binding.agentId, agents: [{ id: binding.agentId }] },
    });
  });

  it("rejects host execution controls on browser-created sessions", async () => {
    const { binding, proxy, request, token } = await setup();

    await expect(
      proxy.request(token, "sessions.create", {
        agentId: binding.agentId,
        worktree: true,
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects privileged session patches and future parameters by default", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;

    await expect(
      proxy.request(token, "sessions.patch", { key, execHost: "gateway" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "chat.send", {
        sessionKey: key,
        message: "hello",
        idempotencyKey: "request-1",
        futureOperatorOption: true,
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "sessions.messages.subscribe", { key, includeApprovals: false }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    await expect(
      proxy.request(token, "sessions.create", { key, model: "company/qwen@operator" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("allows an owned session icon while preserving the authenticated agent", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request.mockResolvedValueOnce({ ok: true, key });

    await expect(proxy.request(token, "sessions.patch", { key, icon: "🧰" })).resolves.toEqual({
      ok: true,
      key,
    });
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key,
      agentId: binding.agentId,
      icon: "🧰",
    });
  });

  it("allows configured model selection only for an owned session", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request
      .mockResolvedValueOnce({
        models: [{ id: "company/qwen", name: "Qwen", provider: "company", available: true }],
      })
      .mockResolvedValueOnce({ ok: true, key });

    await expect(
      proxy.request(token, "sessions.patch", { key, model: "company/qwen" }),
    ).resolves.toEqual({ ok: true, key });
    expect(request).toHaveBeenNthCalledWith(1, "models.list", { view: "configured" });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.patch", {
      key,
      agentId: binding.agentId,
      model: "company/qwen",
    });

    request.mockResolvedValueOnce({ models: [{ id: "company/qwen" }] });
    await expect(
      proxy.request(token, "sessions.patch", { key, model: "company/other" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
  });

  it("accepts the provider-qualified model value produced by the upstream picker", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request
      .mockResolvedValueOnce({
        models: [{ id: "qwen", name: "Qwen", provider: "company", available: true }],
      })
      .mockResolvedValueOnce({ ok: true, key });

    await expect(
      proxy.request(token, "sessions.patch", { key, model: "company/qwen" }),
    ).resolves.toEqual({ ok: true, key });
  });

  it("scopes direct background task reads to the authenticated agent", async () => {
    const { binding, proxy, request, token } = await setup();
    const ownedTask = {
      id: "task-owned",
      status: "running",
      agentId: binding.agentId,
      sessionKey: `agent:${binding.agentId}:main`,
    };
    request.mockResolvedValueOnce({ task: { ...ownedTask, prompt: "Inspect the workspace" } });
    await expect(proxy.request(token, "tasks.get", { taskId: ownedTask.id })).resolves.toEqual({
      task: { ...ownedTask, prompt: "Inspect the workspace" },
    });
  });

  it("filters cross-agent task rows and verifies ownership before cancellation", async () => {
    const { binding, proxy, request, token } = await setup();
    const ownedListTask = {
      id: "task-owned-list",
      status: "running",
      agentId: binding.agentId,
    };
    request.mockResolvedValueOnce({
      tasks: [ownedListTask, { id: "task-other", status: "running", agentId: "other" }],
      nextCursor: "cursor-2",
    });

    await expect(proxy.request(token, "tasks.list", {})).resolves.toEqual({
      tasks: [ownedListTask],
      nextCursor: "cursor-2",
    });
    expect(request).toHaveBeenNthCalledWith(1, "tasks.list", {
      agentId: binding.agentId,
    });
    await expect(proxy.request(token, "tasks.list", { agentId: "other" })).rejects.toMatchObject({
      code: "cross-agent-denied",
    });

    const ownedTask = {
      id: "task-owned",
      status: "running",
      agentId: binding.agentId,
      sessionKey: `agent:${binding.agentId}:main`,
    };
    request.mockResolvedValueOnce({ task: ownedTask }).mockResolvedValueOnce({
      found: true,
      cancelled: true,
      task: { ...ownedTask, status: "cancelled" },
    });

    await expect(proxy.request(token, "tasks.cancel", { taskId: ownedTask.id })).resolves.toEqual({
      found: true,
      cancelled: true,
      task: { ...ownedTask, status: "cancelled" },
    });
    expect(request).toHaveBeenNthCalledWith(2, "tasks.get", { taskId: ownedTask.id });
    expect(request).toHaveBeenNthCalledWith(3, "tasks.cancel", { taskId: ownedTask.id });
  });

  it("projects owned workspace files and read-only skills without host paths", async () => {
    const { binding, proxy, request, token } = await setup();
    request
      .mockResolvedValueOnce({
        agentId: binding.agentId,
        workspace: "/srv/platformclaw/users/person_one",
        files: [
          {
            name: "USER.md",
            path: "/srv/platformclaw/users/person_one/USER.md",
            missing: false,
            size: 12,
          },
        ],
      })
      .mockResolvedValueOnce({
        agentId: binding.agentId,
        workspace: "/srv/platformclaw/users/person_one",
        file: {
          name: "USER.md",
          path: "/srv/platformclaw/users/person_one/USER.md",
          missing: false,
          content: "# Person One",
        },
      })
      .mockResolvedValueOnce({
        workspaceDir: "/srv/platformclaw/users/person_one",
        managedSkillsDir: "/srv/platformclaw/skills",
        agentId: binding.agentId,
        skills: [
          {
            name: "reports",
            skillKey: "reports",
            source: "managed",
            filePath: "/srv/platformclaw/skills/reports/SKILL.md",
            baseDir: "/srv/platformclaw/skills/reports",
          },
        ],
      });

    await expect(proxy.request(token, "agents.files.list", {})).resolves.toEqual({
      agentId: binding.agentId,
      workspace: "personal workspace",
      files: [{ name: "USER.md", path: "USER.md", missing: false, size: 12 }],
    });
    await expect(proxy.request(token, "agents.files.get", { name: "USER.md" })).resolves.toEqual({
      agentId: binding.agentId,
      workspace: "personal workspace",
      file: { name: "USER.md", path: "USER.md", missing: false, content: "# Person One" },
    });
    await expect(proxy.request(token, "skills.status", { refresh: true })).resolves.toEqual({
      workspaceDir: "personal workspace",
      managedSkillsDir: "managed skills",
      agentId: binding.agentId,
      executionTarget: "platform_server",
      agentSkillFilter: undefined,
      skills: [{ name: "reports", skillKey: "reports", source: "managed" }],
    });
    expect(request).toHaveBeenNthCalledWith(1, "agents.files.list", {
      agentId: binding.agentId,
    });
    expect(request).toHaveBeenNthCalledWith(3, "skills.status", {
      agentId: binding.agentId,
      refresh: true,
    });
  });

  it("limits employee skill writes to the bound Basic workspace", async () => {
    const { auditEvents, binding, proxy, request, store, token } = await setup();
    request.mockResolvedValueOnce({
      ok: true,
      message: "Installed calendar@1.0.0",
      slug: "calendar",
      version: "1.0.0",
      targetDir: "/private/workspace/skills/calendar",
    });

    await expect(
      proxy.request(token, "skills.install", { source: "clawhub", slug: "calendar" }),
    ).resolves.toEqual({
      ok: true,
      message: "Installed calendar@1.0.0",
      slug: "calendar",
      version: "1.0.0",
      warning: undefined,
    });
    expect(request).toHaveBeenCalledWith("skills.install", {
      source: "clawhub",
      slug: "calendar",
      agentId: binding.agentId,
    });

    const getPersonalExecutionProfile = vi
      .spyOn(store, "getPersonalExecutionProfile")
      .mockResolvedValue({
        agentBindingId: binding.id,
        activeTarget: "assigned_vm",
        activeAllocationId: "allocation-1",
        targetRevision: 1,
        updatedAt: NOW,
      });
    request.mockResolvedValueOnce({
      workspaceDir: "/users/person/.platformclaw/workspace",
      managedSkillsDir: "/opt/platformclaw/skills",
      skills: [],
    });
    await expect(proxy.request(token, "skills.status", { refresh: true })).resolves.toEqual({
      workspaceDir: "personal workspace",
      managedSkillsDir: "managed skills",
      agentId: binding.agentId,
      executionTarget: "assigned_vm",
      agentSkillFilter: undefined,
      skills: [],
    });
    await expect(
      proxy.request(token, "skills.install", { source: "clawhub", slug: "other" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    request.mockResolvedValueOnce(skillProposalListResult());
    await expect(proxy.request(token, "skills.proposals.list", {})).resolves.toMatchObject({
      proposals: expect.any(Array),
    });
    expect(getPersonalExecutionProfile).toHaveBeenCalledWith(binding.agentId);
    expect(request).toHaveBeenCalledTimes(3);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        eventType: "browser.gateway.denied",
        details: { method: "skills.install", reason: "method-not-allowed" },
      }),
    ]);
  });

  it("removes host paths and foreign runtime identifiers from Skill Workshop results", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce(skillProposalInspectResult(binding.agentId));

    const result = await proxy.request<Record<string, unknown>>(token, "skills.proposals.inspect", {
      proposalId: "proposal-1",
    });

    expect(request).toHaveBeenCalledWith("skills.proposals.inspect", {
      proposalId: "proposal-1",
      agentId: binding.agentId,
    });
    expect(result).toMatchObject({
      record: {
        target: {
          skillName: "Calendar Reports",
          skillKey: "calendar-reports",
          targetLabel: "Development VM",
        },
        origin: {
          agentId: binding.agentId,
          sessionKey: `agent:${binding.agentId}:main`,
        },
      },
      revisionHash: "revision-private",
      content: "# Calendar Reports",
      supportFiles: [],
    });
    expect(JSON.stringify(result)).not.toContain("C:/private");
    expect(JSON.stringify(result)).not.toContain("run-private");
    expect(JSON.stringify(result)).not.toContain("message-private");
    expect(JSON.stringify(result)).not.toContain("hash-private");
    expect(JSON.stringify(result)).not.toContain("allocation-private");
    expect(JSON.stringify(result)).not.toContain("platformclaw-execution-private");

    request.mockResolvedValueOnce(skillProposalListResult());
    const list = await proxy.request<Record<string, unknown>>(token, "skills.proposals.list", {});
    expect(list).toMatchObject({ proposals: [{ targetLabel: "Development VM" }] });
    expect(JSON.stringify(list)).not.toContain("C:/private");
    expect(JSON.stringify(list)).not.toContain("run-private");
  });

  it("routes Skill Workshop revision requests only within the personal Agent", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:revision`;
    request.mockResolvedValueOnce({
      runId: "revision-run-1",
      status: "started",
      internal: "not-for-browser",
    });

    await expect(
      proxy.request(token, "skills.proposals.requestRevision", {
        proposalId: "proposal-1",
        instructions: "Add a validation step",
        sessionKey,
        sessionId: "session-1",
        idempotencyKey: "revision-run-1",
      }),
    ).resolves.toEqual({ runId: "revision-run-1", status: "started" });
    expect(request).toHaveBeenCalledWith("skills.proposals.requestRevision", {
      agentId: binding.agentId,
      targetAgentId: binding.agentId,
      proposalId: "proposal-1",
      instructions: "Add a validation step",
      sessionKey,
      sessionId: "session-1",
      idempotencyKey: "revision-run-1",
    });
    await expect(
      proxy.request(token, "skills.proposals.requestRevision", {
        proposalId: "proposal-1",
        instructions: "Other Agent",
        sessionKey,
        targetAgentId: "other-agent",
        idempotencyKey: "revision-run-2",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
  });

  it("projects directory identity and Agent-scoped profile usage", async () => {
    const { binding, proxy, request, token, user } = await setup();
    request
      .mockResolvedValueOnce({ totalCost: 1 })
      .mockResolvedValueOnce({ sessions: [], totals: {} });

    await expect(proxy.request(token, "users.self", {})).resolves.toEqual({
      profile: {
        id: user.id,
        displayName: "First User",
        avatarMime: null,
        mergedInto: null,
        createdAt: NOW,
        updatedAt: NOW,
        emails: ["first.user@example.test"],
        hasAvatar: false,
      },
    });
    await proxy.request(token, "usage.cost", { agentScope: "all", days: 30 });
    await proxy.request(token, "sessions.usage", { agentScope: "all", groupBy: "day" });
    expect(request).toHaveBeenNthCalledWith(1, "usage.cost", {
      agentId: binding.agentId,
      days: 30,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.usage", {
      agentId: binding.agentId,
      groupBy: "day",
    });
  });

  it("keeps plugin lifecycle administrator-only", async () => {
    const member = await setup();
    await expect(member.proxy.request(member.token, "plugins.list", {})).rejects.toMatchObject({
      code: "method-not-allowed",
    });
    expect(member.request).not.toHaveBeenCalled();

    const admin = await setup({ admin: true });
    admin.request.mockResolvedValueOnce({ plugins: [] });
    await expect(admin.proxy.request(admin.token, "plugins.list", {})).resolves.toEqual({
      plugins: [],
    });
    expect(admin.request).toHaveBeenCalledWith("plugins.list", {});
  });

  it("limits model discovery to a projected configured catalog", async () => {
    const { proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      models: [
        {
          id: "company/qwen",
          name: "Qwen",
          provider: "company",
          available: true,
          apiKeySupported: true,
          agentRuntime: { id: "private-runtime", source: "session" },
        },
      ],
    });

    await expect(proxy.request(token, "models.list", {})).resolves.toEqual({
      models: [{ id: "company/qwen", name: "Qwen", provider: "company", available: true }],
    });
    expect(request).toHaveBeenCalledWith("models.list", { view: "configured" });
    await expect(proxy.request(token, "models.list", { view: "all" })).rejects.toMatchObject({
      code: "method-not-allowed",
    });
    await expect(
      proxy.request(token, "models.list", { includeProviderCapabilities: true }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
  });

  it("suppresses command interpretation and external delivery for browser chat", async () => {
    const { binding, proxy, request, token, user } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request.mockResolvedValueOnce({ status: "started", runId: "run-1" });

    await proxy.request(token, "chat.send", {
      sessionKey: key,
      message: "hello",
      deliver: true,
      idempotencyKey: "request-1",
      expectedLeafEntryId: "leaf-1",
      replyToId: "message-1",
      __controlUiReconnectResume: true,
    });

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        deliver: false,
        expectedLeafEntryId: "leaf-1",
        replyToId: "message-1",
        senderAttribution: expect.objectContaining({ id: user.accountId, profileId: user.id }),
        suppressCommandInterpretation: true,
      }),
    );
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("__controlUiReconnectResume");

    await expect(
      proxy.request(token, "chat.send", {
        sessionKey: key,
        message: "hello",
        idempotencyKey: "request-2",
        senderAttribution: { id: "forged.user" },
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("advertises user commands while removing operator command metadata", async () => {
    const { proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      models: [{ id: "company/qwen" }],
      commands: [
        { name: "new", textAliases: ["/new"], source: "native", category: "session" },
        {
          name: "config",
          textAliases: ["/config"],
          source: "native",
          category: "management",
        },
        {
          name: "plugins",
          textAliases: ["/plugins", "/plugin"],
          source: "native",
          category: "management",
        },
        { name: "phone", textAliases: ["/phone"], source: "plugin", category: "tools" },
      ],
    });

    await expect(proxy.request(token, "chat.metadata", {})).resolves.toEqual({
      models: [{ id: "company/qwen" }],
      commands: [{ name: "new", textAliases: ["/new"], source: "native", category: "session" }],
    });
  });

  it("filters the upstream command-list compatibility path", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      commands: [
        { name: "status", textAliases: ["/status"], source: "native", category: "status" },
        {
          name: "diagnostics",
          textAliases: ["/diagnostics"],
          source: "native",
          category: "status",
        },
        { name: "agents", textAliases: ["/agents"], source: "native", category: "management" },
        { name: "tts", textAliases: ["/tts"], source: "native", category: "media" },
      ],
    });

    await expect(
      proxy.request(token, "commands.list", {
        agentId: binding.agentId,
        includeArgs: true,
        scope: "text",
      }),
    ).resolves.toEqual({
      commands: [
        { name: "status", textAliases: ["/status"], source: "native", category: "status" },
        {
          name: "diagnostics",
          textAliases: ["/diagnostics"],
          source: "native",
          category: "status",
        },
        { name: "agents", textAliases: ["/agents"], source: "native", category: "management" },
        { name: "tts", textAliases: ["/tts"], source: "native", category: "media" },
      ],
    });
    expect(request).toHaveBeenCalledWith("chat.metadata", { agentId: binding.agentId });
  });

  it("allows user slash commands and rejects Gateway administration commands", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request
      .mockResolvedValueOnce({
        commands: [{ name: "new", textAliases: ["/new"], source: "native", category: "session" }],
      })
      .mockResolvedValue({ status: "started" });

    await proxy.request(token, "chat.send", {
      sessionKey: key,
      message: "/new",
      idempotencyKey: "request-safe",
    });
    expect(request).toHaveBeenNthCalledWith(1, "chat.metadata", { agentId: binding.agentId });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "chat.send",
      expect.objectContaining({ suppressCommandInterpretation: false }),
    );

    await proxy.request(token, "chat.send", {
      sessionKey: key,
      message: "Explain why /config is restricted",
      idempotencyKey: "request-plain-text",
    });
    expect(request).toHaveBeenLastCalledWith(
      "chat.send",
      expect.objectContaining({ suppressCommandInterpretation: true }),
    );

    request.mockResolvedValueOnce({
      commands: [{ name: "status", description: "Show status", acceptsArgs: false }],
    });
    await expect(
      proxy.request(token, "chat.send", {
        sessionKey: key,
        message: "/status /danger",
        idempotencyKey: "request-unadvertised-embedded-command",
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).toHaveBeenLastCalledWith("chat.metadata", { agentId: binding.agentId });

    for (const message of [
      "/config show",
      "/plugin: list",
      "/elev@browser on",
      "/bash pwd",
      "/pair qr",
      "/phone arm",
      "/codex status",
      "/think low /exec host=gateway security=full",
    ]) {
      await expect(
        proxy.request(token, "chat.send", {
          sessionKey: key,
          message,
          idempotencyKey: `request-${message}`,
        }),
      ).rejects.toMatchObject({ code: "method-not-allowed" });
    }
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("starts a browser-created session through the command-suppressed chat path", async () => {
    const { binding, proxy, request, token, user } = await setup();
    request
      .mockImplementationOnce(async (_method, params) => ({
        ok: true,
        key: (params as { key: string }).key,
      }))
      .mockResolvedValueOnce({ status: "started", runId: "private-run-id" });

    await expect(
      proxy.request(token, "sessions.create", {
        agentId: binding.agentId,
        message: "hello",
      }),
    ).resolves.toEqual({
      ok: true,
      key: expect.stringMatching(`^agent:${binding.agentId}:dashboard:`),
      runStarted: true,
    });
    const createdKey = (request.mock.calls[0]?.[1] as { key?: unknown } | undefined)?.key;
    if (typeof createdKey !== "string") {
      throw new Error("expected browser-created session key");
    }
    expect(request).toHaveBeenNthCalledWith(1, "sessions.create", {
      agentId: binding.agentId,
      emitCommandHooks: false,
      key: createdKey,
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.send", {
      sessionKey: createdKey,
      agentId: binding.agentId,
      message: "hello",
      idempotencyKey: expect.any(String),
      deliver: false,
      senderAttribution: expect.objectContaining({ id: user.accountId, profileId: user.id }),
      suppressCommandInterpretation: true,
    });
  });

  it("relays new-session attachments through the owned chat path", async () => {
    const { binding, proxy, request, token, user } = await setup();
    const attachment = {
      type: "file",
      mimeType: "text/plain",
      fileName: "notes.txt",
      content: "aGVsbG8=",
    };
    request
      .mockImplementationOnce(async (_method, params) => ({
        ok: true,
        key: (params as { key: string }).key,
      }))
      .mockResolvedValueOnce({ status: "started" });

    await expect(
      proxy.request(token, "sessions.create", {
        agentId: binding.agentId,
        message: "",
        attachments: [attachment],
      }),
    ).resolves.toMatchObject({ ok: true, runStarted: true });

    const createdKey = (request.mock.calls[0]?.[1] as { key?: unknown } | undefined)?.key;
    expect(typeof createdKey).toBe("string");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.create", {
      agentId: binding.agentId,
      emitCommandHooks: false,
      key: createdKey,
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.send", {
      sessionKey: createdKey,
      agentId: binding.agentId,
      message: "",
      attachments: [attachment],
      idempotencyKey: expect.any(String),
      deliver: false,
      senderAttribution: expect.objectContaining({ id: user.accountId, profileId: user.id }),
      suppressCommandInterpretation: true,
    });
  });

  it("rejects malformed new-session attachments before creating a session", async () => {
    const { binding, proxy, request, token } = await setup();

    await expect(
      proxy.request(token, "sessions.create", {
        agentId: binding.agentId,
        message: "hello",
        attachments: { content: "not-an-array" },
      }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps unsafe session message relay methods blocked", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;

    await expect(
      proxy.request(token, "sessions.send", { key, message: "hello" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "sessions.create", { agentId: binding.agentId, task: "run a task" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "sessions.create", { agentId: binding.agentId, message: "/restart" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("projects session mutation responses without operator metadata", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:dashboard:new`;
    request
      .mockResolvedValueOnce({
        ok: true,
        key,
        path: "/srv/platformclaw/state/sessions.json",
        entry: { sessionFile: "/srv/platformclaw/agents/private/transcript.jsonl" },
      })
      .mockResolvedValueOnce({
        ok: true,
        key,
        path: "/srv/platformclaw/state/sessions.json",
        entry: { authProfileOverride: "operator-profile" },
      });

    await expect(proxy.request(token, "sessions.create", { key })).resolves.toEqual({
      ok: true,
      key,
    });
    await expect(proxy.request(token, "sessions.patch", { key, label: "New" })).resolves.toEqual({
      ok: true,
      key,
    });
  });

  it("rejects session run IDs and allows clearing queued work for an owned session", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;

    await expect(
      proxy.request(token, "sessions.abort", { key, runId: "foreign-run" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    request.mockResolvedValueOnce({ ok: true });
    await expect(
      proxy.request(token, "sessions.abort", { key, clearQueued: true }),
    ).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenLastCalledWith("sessions.abort", {
      key,
      agentId: binding.agentId,
      clearQueued: true,
    });
    request.mockResolvedValueOnce({ ok: true });
    await expect(
      proxy.request(token, "chat.abort", { sessionKey: key, runId: "foreign-run" }),
    ).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: key,
      agentId: binding.agentId,
    });
  });

  it("requires owned session keys for search and accepts a missing describe result", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;

    await expect(
      proxy.request(token, "sessions.search", { query: "needle" }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    request.mockResolvedValueOnce({ session: null });
    await expect(proxy.request(token, "sessions.describe", { key })).resolves.toEqual({
      session: null,
    });
    expect(request).toHaveBeenLastCalledWith("sessions.describe", { key });
  });

  it("rejects foreign search and preview rows instead of leaking collection metadata", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request
      .mockResolvedValueOnce({
        total: 2,
        results: [
          { sessionKey: key, agentId: binding.agentId },
          { sessionKey: "agent:other:main", agentId: "other" },
        ],
      })
      .mockResolvedValueOnce({
        total: 2,
        previews: [{ key }, { key: "agent:other:main" }],
      });

    await expect(
      proxy.request(token, "sessions.search", { sessionKeys: [key], query: "needle" }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
    await expect(proxy.request(token, "sessions.preview", { keys: [key] })).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
  });

  it("projects direct message lookup results from the pinned session", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request.mockResolvedValueOnce({
      ok: true,
      message: { role: "assistant", content: "hello" },
      internalPath: "/srv/platformclaw/other/transcript.jsonl",
    });

    await expect(
      proxy.request(token, "chat.message.get", { sessionKey: key, messageId: "message-1" }),
    ).resolves.toEqual({
      ok: true,
      message: { role: "assistant", content: "hello" },
    });
  });

  it("denies and audits cross-agent session identifiers returned by Gateway", async () => {
    const { auditEvents, binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({ ok: true, key: "agent:other:new" });

    await expect(
      proxy.request(token, "sessions.create", { agentId: binding.agentId }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
    expect(auditEvents).toEqual([
      expect.objectContaining({
        eventType: "browser.gateway.denied",
        details: { method: "sessions.create", reason: "upstream-result-denied" },
      }),
    ]);
  });

  it("drops cross-agent and unscoped events", async () => {
    const { binding, proxy, token } = await setup();
    const owned = {
      event: "chat",
      payload: { sessionKey: `agent:${binding.agentId}:main`, agentId: binding.agentId },
    };

    await expect(proxy.filterEvent(token, owned)).resolves.toEqual(owned);
    await expect(
      proxy.filterEvent(token, {
        event: "chat",
        payload: { sessionKey: "agent:other:main", agentId: "other" },
      }),
    ).resolves.toBeNull();
    const ordinaryNestedPayload = {
      event: "session.tool",
      payload: {
        sessionKey: `agent:${binding.agentId}:main`,
        agentId: binding.agentId,
        data: { agentId: "external-service-id", sessionKey: "opaque-tool-input" },
      },
    };
    await expect(proxy.filterEvent(token, ordinaryNestedPayload)).resolves.toEqual(
      ordinaryNestedPayload,
    );
    const ownedObserverPayload = {
      event: "session.observer",
      payload: {
        sessionKey: `agent:${binding.agentId}:main`,
        agentId: binding.agentId,
        runId: "run-1",
      },
    };
    await expect(proxy.filterEvent(token, ownedObserverPayload)).resolves.toEqual(
      ownedObserverPayload,
    );
    await expect(
      proxy.filterEvent(token, {
        event: "session.observer",
        payload: { sessionKey: "agent:other:main", agentId: "other", runId: "run-2" },
      }),
    ).resolves.toBeNull();
    await expect(
      proxy.filterEvent(token, {
        event: "sessions.changed",
        payload: {
          sessionKey: `agent:${binding.agentId}:main`,
          agentId: binding.agentId,
          childSessions: [`agent:${binding.agentId}:child`, "agent:other:child"],
        },
      }),
    ).resolves.toBeNull();
    await expect(
      proxy.filterEvent(token, {
        event: "chat",
        payload: { agentId: binding.agentId },
      }),
    ).resolves.toBeNull();
    await expect(
      proxy.filterEvent(token, {
        event: "agent",
        payload: { runId: "run-1", agentId: binding.agentId },
      }),
    ).resolves.toBeNull();
    await expect(proxy.filterEvent(token, { event: "presence", payload: {} })).resolves.toBeNull();
    const ownedTaskEvent = {
      event: "task",
      payload: {
        action: "upserted",
        task: {
          id: "task-owned",
          status: "running",
          agentId: binding.agentId,
          sessionKey: `agent:${binding.agentId}:main`,
        },
      },
    };
    await expect(proxy.filterEvent(token, ownedTaskEvent)).resolves.toEqual(ownedTaskEvent);
    await expect(
      proxy.filterEvent(token, {
        event: "task",
        payload: {
          action: "upserted",
          task: { id: "task-other", status: "running", agentId: "other" },
        },
      }),
    ).resolves.toBeNull();
    await expect(
      proxy.filterEvent(token, { event: "task", payload: { action: "deleted", taskId: "opaque" } }),
    ).resolves.toBeNull();
    await expect(
      proxy.filterEvent(token, { event: "tick", payload: { ts: NOW } }),
    ).resolves.toEqual({
      event: "tick",
      payload: { ts: NOW },
    });
  });

  it("rejects requests after browser-session revocation", async () => {
    const { created, proxy, request, store, token } = await setup();
    if (created.status !== "created") {
      throw new Error("expected browser session");
    }
    await store.revokeBrowserSession(created.session.id, NOW);

    await expect(proxy.request(token, "models.list", {})).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(request).not.toHaveBeenCalled();
  });
});
