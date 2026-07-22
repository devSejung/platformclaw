import { describe, expect, it, vi } from "vitest";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { BrowserGatewayProxy, type BrowserGatewayRpc } from "./browser-gateway-proxy.js";
import type {
  ControlAuditEvent,
  ControlPlaneAuditWriter,
  EnterprisePrincipal,
} from "./contracts.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";

const NOW = 1_000_000;

function sessionAgentId(sessionKey: string): string | null {
  const match = /^agent:([^:]+):/.exec(sessionKey.trim());
  return match?.[1] ?? null;
}

async function setup() {
  let sequence = 0;
  const store = new InMemoryControlPlaneStore({
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    idFactory: {
      nextUserId: () => `user-${++sequence}`,
      nextBindingId: () => `binding-${++sequence}`,
      nextSessionId: () => `session-${++sequence}`,
      nextManagedScopeId: () => `scope-${++sequence}`,
      nextAuditEventId: () => `audit-${++sequence}`,
    },
  });
  const principal: EnterprisePrincipal = {
    provider: "ldap",
    subject: "employee-1",
    accountId: "first.user",
    employeeId: "1001",
  };
  const { user } = await store.upsertPrincipal(principal, NOW);
  const reserved = await store.reservePersonalAgent(user.id, NOW);
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: NOW,
  });
  if (binding.kind !== "personal") {
    throw new Error("expected personal binding");
  }
  const token = "test-token";
  const created = await store.createBrowserSession({
    userId: user.id,
    tokenHash: hashBrowserSessionToken(token),
    createdAt: NOW,
  });
  if (created.status !== "created") {
    throw new Error("expected browser session");
  }
  const service = new BrowserAuthService({
    store,
    authenticator: {
      async authenticatePassword() {
        return { status: "rejected" as const, message: "unused" };
      },
    },
    provisioner: { provisionOrRefresh: vi.fn(async () => undefined) },
    now: () => NOW,
  });
  const request = vi.fn<BrowserGatewayRpc["request"]>(async () => ({ ok: true }));
  const auditEvents: ControlAuditEvent[] = [];
  const auditWriter: ControlPlaneAuditWriter = {
    async recordAuditEvent(params) {
      const event: ControlAuditEvent = { id: `audit-${auditEvents.length + 1}`, ...params };
      auditEvents.push(event);
      return event;
    },
  };
  const proxy = new BrowserGatewayProxy({
    authService: service,
    store,
    auditWriter,
    gateway: { request },
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    resolveAgentIdFromSessionKey: sessionAgentId,
    now: () => NOW,
  });
  return { auditEvents, binding, created, proxy, request, store, token, user };
}

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
    await expect(proxy.request(token, "sessions.list", {})).resolves.toMatchObject({
      total: 25,
      sessions: [{ key: `agent:${binding.agentId}:main` }],
    });
    expect(request).toHaveBeenLastCalledWith("sessions.list", {
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
      proxy.request(token, "sessions.messages.subscribe", { key, includeApprovals: true }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "sessions.patch", { key, archived: true }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "sessions.create", { key, model: "company/qwen@operator" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
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

  it("scopes background task reads to the authenticated agent", async () => {
    const { binding, proxy, request, token } = await setup();
    const ownedTask = {
      id: "task-owned",
      status: "running",
      agentId: binding.agentId,
      sessionKey: `agent:${binding.agentId}:main`,
    };
    request
      .mockResolvedValueOnce({ tasks: [ownedTask] })
      .mockResolvedValueOnce({ task: { ...ownedTask, prompt: "Inspect the workspace" } });

    await expect(
      proxy.request(token, "tasks.list", {
        agentId: binding.agentId,
        status: ["queued", "running"],
        limit: 50,
      }),
    ).resolves.toEqual({ tasks: [ownedTask] });
    expect(request).toHaveBeenNthCalledWith(1, "tasks.list", {
      agentId: binding.agentId,
      status: ["queued", "running"],
      limit: 50,
    });
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
    await expect(proxy.request(token, "skills.status", {})).resolves.toEqual({
      workspaceDir: "personal workspace",
      managedSkillsDir: "managed skills",
      agentId: binding.agentId,
      agentSkillFilter: undefined,
      skills: [{ name: "reports", skillKey: "reports", source: "managed" }],
    });
    expect(request).toHaveBeenNthCalledWith(1, "agents.files.list", {
      agentId: binding.agentId,
    });
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
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request.mockResolvedValueOnce({ status: "started", runId: "run-1" });

    await proxy.request(token, "chat.send", {
      sessionKey: key,
      message: "hello",
      deliver: true,
      idempotencyKey: "request-1",
      __controlUiReconnectResume: true,
    });

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        agentId: binding.agentId,
        deliver: false,
        suppressCommandInterpretation: true,
      }),
    );
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("__controlUiReconnectResume");
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
    const { binding, proxy, request, token } = await setup();
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
      suppressCommandInterpretation: true,
    });
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

  it("rejects session run IDs and strips chat run IDs before aborting an owned session", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;

    await expect(
      proxy.request(token, "sessions.abort", { key, runId: "foreign-run" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    request.mockResolvedValueOnce({ ok: true });
    await expect(
      proxy.request(token, "chat.abort", { sessionKey: key, runId: "foreign-run" }),
    ).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
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
