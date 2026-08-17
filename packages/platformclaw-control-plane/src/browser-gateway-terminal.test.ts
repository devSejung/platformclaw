import { describe, expect, it, vi } from "vitest";
import {
  NOW,
  setupBrowserGatewayProxyTest as setup,
} from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayTerminalController", () => {
  it("opens, reattaches, and isolates one assigned-VM terminal per personal Agent", async () => {
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
    await expect(
      proxy.request(token, "terminal.open", { cols: 80, rows: 24 }, { connectionId: "web-2" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });

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
      sessions: [{ sessionId: "terminal-1", agentId: binding.agentId, attached: false }],
    });

    request.mockResolvedValueOnce({
      sessionId: "terminal-1",
      agentId: binding.agentId,
      shell: "person_one login shell",
      cwd: "/home/person_one",
      confined: true,
      buffer: "ready",
    });
    await expect(
      proxy.request(
        token,
        "terminal.attach",
        { sessionId: "terminal-1" },
        { connectionId: "web-2" },
      ),
    ).resolves.toMatchObject({ sessionId: "terminal-1", buffer: "ready" });
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
});
