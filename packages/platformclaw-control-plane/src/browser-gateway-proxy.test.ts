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
      proxy.request(token, "sessions.patch", { key, model: "company/qwen@operator" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "sessions.create", { key, model: "company/qwen@operator" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
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

  it("removes operator command metadata from browser responses", async () => {
    const { proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      models: [{ id: "company/qwen" }],
      commands: [{ name: "config" }],
    });

    await expect(proxy.request(token, "chat.metadata", {})).resolves.toEqual({
      models: [{ id: "company/qwen" }],
    });
  });

  it("rejects message relay methods that cannot suppress Gateway commands", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;

    await expect(
      proxy.request(token, "sessions.send", { key, message: "hello" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "sessions.create", { agentId: binding.agentId, message: "hello" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "sessions.create", { agentId: binding.agentId, task: "run a task" }),
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

  it("rejects browser-selected run IDs for both abort methods", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;

    await expect(
      proxy.request(token, "sessions.abort", { key, runId: "foreign-run" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "chat.abort", { sessionKey: key, runId: "foreign-run" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
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
