import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy live capabilities", () => {
  it("projects live agent, question, suggestion, and skill events to the personal agent", async () => {
    const { binding, proxy, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    const agentEvent = { event: "agent", payload: { sessionKey, agentId: binding.agentId } };
    await expect(proxy.filterEvent(token, agentEvent)).resolves.toEqual(agentEvent);
    await expect(
      proxy.filterEvent(token, {
        event: "agent",
        payload: { sessionKey: "agent:other:main", agentId: "other" },
      }),
    ).resolves.toBeNull();
    await expect(
      proxy.filterEvent(token, { event: "skills.changed", payload: { revision: 2 } }),
    ).resolves.toEqual({ event: "skills.changed", payload: { revision: 2 } });

    const question = {
      id: "question-1",
      agentId: binding.agentId,
      sessionKey,
      questions: [],
    };
    await expect(
      proxy.filterEvent(token, { event: "question.requested", payload: question }),
    ).resolves.toEqual({ event: "question.requested", payload: question });
    await expect(
      proxy.filterEvent(token, {
        event: "question.resolved",
        payload: { id: "question-1", status: "answered" },
      }),
    ).resolves.toEqual({
      event: "question.resolved",
      payload: { id: "question-1", status: "answered" },
    });

    const suggestion = { id: "suggestion-1", agentId: binding.agentId, sessionKey };
    await expect(
      proxy.filterEvent(token, {
        event: "task.suggestion",
        payload: { action: "created", suggestion },
      }),
    ).resolves.toEqual({
      event: "task.suggestion",
      payload: { action: "created", suggestion },
    });
  });

  it("binds session approval replay and permits only session-scoped decisions", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    const approval = {
      id: "approval-1",
      status: "pending",
      urlPath: "/approvals/approval-1",
      createdAtMs: 1,
      expiresAtMs: 2,
      presentation: {
        kind: "exec",
        commandText: "echo safe",
        agentId: binding.agentId,
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    };
    request.mockResolvedValueOnce({
      subscribed: true,
      key: sessionKey,
      approvalReplay: {
        sessionKey,
        updatedAtMs: 1,
        approvals: [approval],
        truncated: false,
      },
    });
    const subscribed = await proxy.request(token, "sessions.messages.subscribe", {
      key: sessionKey,
      includeApprovals: true,
    });
    expect(subscribed).toMatchObject({
      approvalReplay: {
        approvals: [{ presentation: { allowedDecisions: ["allow-once", "deny"] } }],
      },
    });
    request.mockResolvedValueOnce({ applied: true });
    await expect(
      proxy.request(token, "approval.resolve", {
        id: "approval-1",
        kind: "exec",
        decision: "allow-once",
      }),
    ).resolves.toEqual({ applied: true });
    await expect(
      proxy.request(token, "approval.resolve", {
        id: "approval-1",
        kind: "exec",
        decision: "allow-always",
      }),
    ).rejects.toMatchObject({ code: "invalid-params" });
  });

  it("multiplexes pull-request watches by browser connection", async () => {
    const { binding, proxy, request, token } = await setup();
    const connectionId = "browser-tab-1";
    const sessionKey = `agent:${binding.agentId}:main`;
    proxy.registerBrowserConnection(connectionId);
    request.mockResolvedValueOnce({ subscribed: true });
    await expect(
      proxy.request(
        token,
        "controlUi.sessionPullRequests.subscribe",
        { sessionKeys: [sessionKey] },
        { connectionId },
      ),
    ).resolves.toEqual({ subscribed: true });
    expect(request).toHaveBeenLastCalledWith("controlUi.sessionPullRequests.subscribe", {
      sessionKeys: [sessionKey],
      subscriptionId: connectionId,
    });
    await expect(
      proxy.filterEvent(
        token,
        {
          event: "controlUi.sessionPullRequests.changed",
          payload: { sessions: { [sessionKey]: { pullRequests: [] } } },
        },
        { connectionId },
      ),
    ).resolves.toEqual({
      event: "controlUi.sessionPullRequests.changed",
      payload: { sessions: { [sessionKey]: { pullRequests: [] } } },
    });
  });
});
