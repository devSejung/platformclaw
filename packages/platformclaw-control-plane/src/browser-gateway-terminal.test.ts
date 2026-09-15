import { describe, expect, it, vi } from "vitest";
import { hashBrowserSessionToken } from "./browser-auth-service.js";
import {
  NOW,
  setupBrowserGatewayProxyTest as setup,
} from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayTerminalController", () => {
  it("cleans up failed open audits and reports asynchronous exit audit failures", async () => {
    const { auditWriter, binding, proxy, request, store, token } = await setup();
    vi.spyOn(store, "getPersonalExecutionProfile").mockResolvedValue({
      agentBindingId: binding.id,
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 7,
      updatedAt: NOW,
    });
    const auditFailure = new Error("private database diagnostic");
    const writer = vi.spyOn(auditWriter, "recordAuditEvent").mockRejectedValue(auditFailure);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const terminal = {
      sessionId: "audit-terminal",
      agentId: binding.agentId,
      confined: true,
      shell: "login shell",
      cwd: "/home/person_one",
      buffer: "",
      seq: 0,
    };
    request.mockImplementation(async (method) =>
      method === "terminal.open" || method === "terminal.attach" ? terminal : {},
    );
    try {
      await expect(
        proxy.request(
          token,
          "terminal.open",
          { cols: 80, rows: 24 },
          { connectionId: "web-audit" },
        ),
      ).rejects.toBe(auditFailure);
      expect(request).toHaveBeenCalledWith("terminal.close", { sessionId: terminal.sessionId });
      await expect(
        proxy.request(token, "terminal.list", {}, { connectionId: "web-audit" }),
      ).resolves.toEqual({ sessions: [] });
      expect(writer).toHaveBeenCalledTimes(2);
      expect(diagnostic.mock.calls).toEqual([
        [
          "PlatformClaw terminal audit failed",
          { eventType: "browser.terminal.opened", outcome: "opened" },
        ],
        [
          "PlatformClaw terminal audit failed",
          { eventType: "browser.terminal.closed", outcome: "open_failed" },
        ],
      ]);
      writer.mockImplementation(async (params) => ({ id: "recovered-audit", ...params }));
      await proxy.request(
        token,
        "terminal.open",
        { cols: 80, rows: 24 },
        { connectionId: "web-audit" },
      );
      writer.mockRejectedValue(auditFailure);
      diagnostic.mockClear();
      expect(
        proxy.filterConnectionEvent(
          {
            event: "terminal.exit",
            payload: { sessionId: terminal.sessionId, reason: "process_exit", exitCode: 0 },
          },
          { connectionId: "web-audit" },
        ),
      ).toMatchObject({ event: "terminal.exit" });
      await vi.waitFor(() =>
        expect(diagnostic).toHaveBeenCalledWith("PlatformClaw terminal audit failed", {
          eventType: "browser.terminal.closed",
          outcome: "process_exit",
        }),
      );
      await expect(
        proxy.request(token, "terminal.list", {}, { connectionId: "web-audit" }),
      ).resolves.toEqual({ sessions: [] });
    } finally {
      diagnostic.mockRestore();
      writer.mockRestore();
    }
  });
  it("opens and transfers an assigned-VM terminal with visible browser ownership", async () => {
    const { binding, proxy, request, store, token } = await setup();
    vi.spyOn(store, "getPersonalExecutionProfile").mockResolvedValue({
      agentBindingId: binding.id,
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 7,
      updatedAt: NOW,
    });
    request
      .mockResolvedValueOnce({
        sessionId: "terminal-1",
        agentId: binding.agentId,
        shell: "person_one login shell",
        cwd: "/home/person_one",
        confined: true,
      })
      .mockResolvedValueOnce({
        sessionId: "terminal-1",
        agentId: binding.agentId,
        shell: "person_one login shell",
        cwd: "/home/person_one",
        confined: true,
        buffer: "welcome",
        seq: 7,
      });

    await expect(
      proxy.request(token, "terminal.open", { cols: 100, rows: 30 }, { connectionId: "web-1" }),
    ).resolves.toMatchObject({
      sessionId: "terminal-1",
      confined: true,
      buffer: "welcome",
      seq: 7,
    });
    expect(request).toHaveBeenCalledWith("terminal.open", {
      agentId: binding.agentId,
      cols: 100,
      rows: 30,
    });

    request.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: "terminal-1",
          agentId: binding.agentId,
          shell: "person_one login shell",
          cwd: "/home/person_one",
          confined: true,
          attached: true,
          owner: "conn",
          createdAtMs: NOW,
        },
        { sessionId: "other-terminal", agentId: "other", confined: true },
      ],
    });
    await expect(
      proxy.request(token, "terminal.list", {}, { connectionId: "web-2" }),
    ).resolves.toMatchObject({
      sessions: [
        { sessionId: "terminal-1", agentId: binding.agentId, attached: false, available: false },
      ],
    });

    request.mockResolvedValueOnce({
      sessionId: "terminal-1",
      agentId: binding.agentId,
      shell: "person_one login shell",
      cwd: "/home/person_one",
      confined: true,
      buffer: "ready",
    });
    const detached = vi.fn();
    const unsubscribe = proxy.subscribeConnectionEvents("web-1", detached);
    await expect(
      proxy.request(
        token,
        "terminal.attach",
        { sessionId: "terminal-1" },
        { connectionId: "web-2" },
      ),
    ).resolves.toMatchObject({ sessionId: "terminal-1", buffer: "ready" });
    expect(detached).toHaveBeenCalledWith({
      event: "terminal.exit",
      payload: { sessionId: "terminal-1", reason: "detached", exitCode: null },
    });
    for (const method of ["terminal.input", "terminal.resize", "terminal.close"]) {
      await expect(
        proxy.request(
          token,
          method,
          {
            sessionId: "terminal-1",
            ...(method === "terminal.input"
              ? { data: "x" }
              : method === "terminal.resize"
                ? { cols: 80, rows: 24 }
                : {}),
          },
          { connectionId: "web-1" },
        ),
      ).rejects.toMatchObject({ code: "method-not-allowed" });
    }
    unsubscribe();
    const { user: peer } = await store.upsertPrincipal(
      {
        provider: "ldap",
        subject: "employee-2",
        accountId: "second.user",
        employeeId: "1002",
        displayName: "Second User",
        email: "second.user@example.test",
      },
      NOW,
    );
    const peerBinding = await store.reservePersonalAgent(peer.id, NOW);
    await store.transitionAgent({
      bindingId: peerBinding.binding.id,
      state: "active",
      changedAt: NOW,
    });
    const peerToken = "peer-token";
    await store.createBrowserSession({
      userId: peer.id,
      tokenHash: hashBrowserSessionToken(peerToken),
      createdAt: NOW,
    });
    await expect(
      proxy.request(peerToken, "terminal.list", {}, { connectionId: "peer-web" }),
    ).resolves.toEqual({ sessions: [] });
    for (const method of ["terminal.attach", "terminal.close"]) {
      await expect(
        proxy.request(peerToken, method, { sessionId: "terminal-1" }, { connectionId: "peer-web" }),
      ).rejects.toMatchObject({ code: "cross-agent-denied" });
    }
    expect(
      proxy.filterConnectionEvent(
        { event: "terminal.data", payload: { sessionId: "terminal-1", data: "ok" } },
        { connectionId: "web-1" },
      ),
    ).toBeNull();
    expect(
      proxy.filterConnectionEvent(
        { event: "terminal.data", payload: { sessionId: "terminal-1", data: "ok" } },
        { connectionId: "web-2" },
      ),
    ).toMatchObject({ event: "terminal.data" });
  });

  it("reserves eight simultaneous opens before profile I/O and releases capacity on close", async () => {
    const { binding, proxy, request, store, token } = await setup();
    let resolveProfile!: (value: unknown) => void;
    const pendingProfile = new Promise((resolve) => {
      resolveProfile = resolve;
    });
    const profile = {
      agentBindingId: binding.id,
      activeTarget: "assigned_vm" as const,
      activeAllocationId: "allocation-1",
      targetRevision: 7,
      updatedAt: NOW,
    };
    const loadProfile = vi
      .spyOn(store, "getPersonalExecutionProfile")
      .mockImplementation(async () => (await pendingProfile) as typeof profile);
    let sequence = 0;
    const sessions = new Map<string, Record<string, unknown>>();
    request.mockImplementation(async (method, params) => {
      const id = (params as { sessionId?: string } | undefined)?.sessionId;
      if (method === "terminal.open") {
        const session = {
          sessionId: `terminal-${++sequence}`,
          agentId: binding.agentId,
          confined: true,
          shell: "login shell",
          cwd: "/home/person_one",
          buffer: "",
          seq: 0,
        };
        sessions.set(session.sessionId, session);
        return session;
      }
      if (method === "terminal.attach") {
        return sessions.get(id!);
      }
      if (method === "terminal.list") {
        return { sessions: [...sessions.values()] };
      }
      if (method === "terminal.close") {
        sessions.delete(id!);
      }
      return {};
    });
    const opens = Array.from({ length: 8 }, (_, index) =>
      proxy.request(
        token,
        "terminal.open",
        { cols: 80, rows: 24 },
        { connectionId: `web-${index}` },
      ),
    );
    await vi.waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(8));
    await expect(
      proxy.request(token, "terminal.open", { cols: 80, rows: 24 }, { connectionId: "web-ninth" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
    resolveProfile(profile);
    await Promise.all(opens);
    expect(sessions.size).toBe(8);
    await proxy.request(
      token,
      "terminal.close",
      { sessionId: "terminal-1" },
      { connectionId: "web-0" },
    );
    await proxy.request(token, "terminal.open", { cols: 80, rows: 24 }, { connectionId: "web-0" });
    expect(sessions.size).toBe(8);
    await proxy.closeTerminalsForAgent(binding.agentId, "revoked");
    expect(sessions.size).toBe(0);
    await expect(
      proxy.request(
        token,
        "terminal.input",
        { sessionId: "terminal-2", data: "x" },
        { connectionId: "web-1" },
      ),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
  });

  it("rejects Basic terminals and browser-selected terminal authority", async () => {
    const { proxy, request, token } = await setup();

    await expect(
      proxy.request(token, "terminal.open", { cols: 80, rows: 24 }, { connectionId: "web-1" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(
        token,
        "terminal.open",
        { cols: 80, rows: 24, agentId: "other" },
        { connectionId: "web-1" },
      ),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a disconnected terminal for five minutes, then closes it", async () => {
    vi.useFakeTimers();
    try {
      const { binding, proxy, request, store, token } = await setup();
      vi.spyOn(store, "getPersonalExecutionProfile").mockResolvedValue({
        agentBindingId: binding.id,
        activeTarget: "assigned_vm",
        activeAllocationId: "allocation-1",
        targetRevision: 7,
        updatedAt: NOW,
      });
      request
        .mockResolvedValueOnce({
          sessionId: "terminal-1",
          agentId: binding.agentId,
          shell: "login shell",
          cwd: "/home/person_one",
          confined: true,
        })
        .mockResolvedValueOnce({
          sessionId: "terminal-1",
          agentId: binding.agentId,
          shell: "login shell",
          cwd: "/home/person_one",
          confined: true,
          buffer: "",
          seq: 0,
        });
      await proxy.request(
        token,
        "terminal.open",
        { cols: 80, rows: 24 },
        { connectionId: "web-1" },
      );
      request.mockClear();

      await proxy.releaseBrowserConnection("web-1");
      await vi.advanceTimersByTimeAsync(299_999);
      expect(request).not.toHaveBeenCalledWith("terminal.close", { sessionId: "terminal-1" });
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledWith("terminal.close", { sessionId: "terminal-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls back an open completed after its browser disconnects", async () => {
    const { binding, proxy, request, store, token } = await setup();
    vi.spyOn(store, "getPersonalExecutionProfile").mockResolvedValue({
      agentBindingId: binding.id,
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 7,
      updatedAt: NOW,
    });
    let finish!: (value: unknown) => void;
    request.mockImplementation(async (method) =>
      method === "terminal.open"
        ? await new Promise((resolve) => {
            finish = resolve;
          })
        : {
            sessionId: "late-terminal",
            agentId: binding.agentId,
            confined: true,
            buffer: "",
            seq: 0,
          },
    );
    let connected = true;
    const opening = proxy.request(
      token,
      "terminal.open",
      { cols: 80, rows: 24 },
      { connectionId: "web-late", isConnected: () => connected },
    );
    const rejected = expect(opening).rejects.toMatchObject({ code: "unauthenticated" });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("terminal.open", expect.anything()),
    );
    connected = false;
    await proxy.releaseBrowserConnection("web-late");
    finish({
      sessionId: "late-terminal",
      agentId: binding.agentId,
      confined: true,
      shell: "login shell",
      cwd: "/home/person_one",
    });
    await rejected;
    expect(request).toHaveBeenCalledWith("terminal.close", { sessionId: "late-terminal" });
    await expect(
      proxy.request(token, "terminal.list", {}, { connectionId: "web-new" }),
    ).resolves.toEqual({ sessions: [] });
  });

  it("revokes a pending open before a terminal record exists", async () => {
    const { binding, proxy, request, store, token } = await setup();
    vi.spyOn(store, "getPersonalExecutionProfile").mockResolvedValue({
      agentBindingId: binding.id,
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 7,
      updatedAt: NOW,
    });
    let finish!: (value: unknown) => void;
    request.mockImplementation(async (method) =>
      method === "terminal.open"
        ? await new Promise((resolve) => {
            finish = resolve;
          })
        : {
            sessionId: "revoked-terminal",
            agentId: binding.agentId,
            confined: true,
            buffer: "",
            seq: 0,
          },
    );
    const opening = proxy.request(
      token,
      "terminal.open",
      { cols: 80, rows: 24 },
      { connectionId: "web-pending" },
    );
    const rejected = expect(opening).rejects.toMatchObject({ code: "method-not-allowed" });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("terminal.open", expect.anything()),
    );
    await proxy.closeTerminalsForAgent(binding.agentId, "allocation_revoked");
    expect(request).not.toHaveBeenCalledWith("terminal.close", expect.anything());
    finish({
      sessionId: "revoked-terminal",
      agentId: binding.agentId,
      confined: true,
      shell: "login shell",
      cwd: "/home/person_one",
    });
    await rejected;
    expect(request).toHaveBeenCalledWith("terminal.close", { sessionId: "revoked-terminal" });
    await expect(
      proxy.request(token, "terminal.list", {}, { connectionId: "web-new" }),
    ).resolves.toEqual({ sessions: [] });
  });
});
