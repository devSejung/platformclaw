import { describe, expect, it } from "vitest";
import {
  buildGatewaySessionEventFields,
  buildGatewaySessionEventRow,
} from "../../../src/gateway/session-event-payload.js";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy live capabilities", () => {
  it("delivers committed transcript messages with the Gateway's cleared controller metadata", async () => {
    const { binding, proxy, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    const sessionRow = {
      key: sessionKey,
      kind: "direct" as const,
      updatedAt: 1,
      sessionId: "session-1",
    };
    const event = {
      event: "session.message",
      payload: {
        sessionKey,
        agentId: binding.agentId,
        message: { role: "assistant", content: [{ type: "text", text: "Completed" }] },
        session: buildGatewaySessionEventRow(sessionRow),
        ...buildGatewaySessionEventFields({ sessionRow }),
      },
    };
    expect(event.payload).toHaveProperty("controlOwnerSessionKey", null);

    await expect(proxy.filterEvent(token, event)).resolves.toEqual(event);
  });

  it("preserves optional lineage clears and owned links on live events", async () => {
    const { binding, proxy, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    const fields = ["parentSessionKey", "childSessionKey", "spawnedBy", "controlOwnerSessionKey"];
    for (const field of fields) {
      for (const value of [null, `agent:${binding.agentId}:child`]) {
        const event = {
          event: "session.message",
          payload: {
            sessionKey,
            agentId: binding.agentId,
            [field]: value,
            session: { key: sessionKey, [field]: value },
          },
        };
        await expect(proxy.filterEvent(token, event)).resolves.toEqual(event);
      }
    }
  });

  it("rejects foreign and malformed live-event ownership references", async () => {
    const { binding, proxy, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    for (const ownership of [
      { sessionKey: "agent:other:main" },
      { sessionKey: 42 },
      { sessionKey: null },
      { key: "agent:other:main" },
      { key: 42 },
      { agentId: "other" },
      { agentId: 42 },
      { session: { key: "agent:other:main" } },
      { session: { key: 42 } },
      ...["parentSessionKey", "childSessionKey", "spawnedBy", "controlOwnerSessionKey"].flatMap(
        (field) => ["agent:other:main", 42, ""].map((value) => ({ [field]: value })),
      ),
    ]) {
      await expect(
        proxy.filterEvent(token, {
          event: "session.message",
          payload: { sessionKey, agentId: binding.agentId, ...ownership },
        }),
      ).resolves.toBeNull();
    }
  });

  it("projects live agent, question, suggestion, and skill events to the personal agent", async () => {
    const { binding, proxy, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    const agentEvent = { event: "agent", payload: { sessionKey, agentId: binding.agentId } };
    await expect(proxy.filterEvent(token, agentEvent)).resolves.toEqual(agentEvent);
    const chatEvent = {
      event: "chat",
      payload: {
        sessionKey,
        agentId: binding.agentId,
        runId: "run-1",
        state: "delta",
        deltaText: "Still working",
      },
    };
    await expect(proxy.filterEvent(token, chatEvent)).resolves.toEqual(chatEvent);
    const messageEvent = {
      event: "session.message",
      payload: { sessionKey, agentId: binding.agentId, message: { role: "assistant" } },
    };
    await expect(proxy.filterEvent(token, messageEvent)).resolves.toEqual(messageEvent);
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
    const connectionId = "browser-tab-approval";
    proxy.registerBrowserConnection(connectionId);
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
    const subscribed = await proxy.request(
      token,
      "sessions.messages.subscribe",
      { key: sessionKey, includeApprovals: true },
      { connectionId },
    );
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
