/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createSessionContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function advertiseSessionCreate(pane: TestChatPane) {
  pane.context.gateway.snapshot.hello = {
    auth: { role: "operator", scopes: ["operator.write"] },
    features: { methods: ["sessions.create"] },
  } as typeof pane.context.gateway.snapshot.hello;
}

function enableBoardSession(pane: TestChatPane) {
  Reflect.set(pane, "resolveBoardView", () => ({
    hasBoard: true,
    snapshot: { sessionKey: "agent:main:current" },
  }));
  pane.context.gateway.snapshot.hello = {
    auth: { role: "operator", scopes: ["operator.admin"] },
    features: { methods: ["sessions.reset"] },
  } as typeof pane.context.gateway.snapshot.hello;
}

describe("chat pane session creation lifecycle", () => {
  it("creates /new prompts atomically with the distinct session", async () => {
    const sessions = {
      createResult: vi.fn(async () => ({
        key: "agent:main:new",
        initialRun: { status: "started", messageId: "initial-run", messageSeq: 3 },
      })),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    advertiseSessionCreate(pane);

    await expect(pane.createSession("take notes")).resolves.toBe(true);

    expect(sessions.createResult).toHaveBeenCalledWith({
      currentSessionKey: "agent:main:current",
      agentId: "main",
      message: "take notes",
    });
    expect(navigate).toHaveBeenCalledWith(expect.any(String), "agent:main:new");
  });

  it("retains a board /new prompt when reset completion is uncertain", async () => {
    const sessions = {
      reset: vi.fn(async () => {
        state.connected = false;
        return "uncertain" as const;
      }),
    } as unknown as SessionCapability;
    const request = vi.fn();
    const created = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions,
    });
    const state = created.state;
    enableBoardSession(created.pane);

    const pending = created.pane.createSession("take notes");
    await vi.waitFor(() => expect(created.pane.resetConfirmationOpen).toBe(true));
    created.pane.settleResetConfirmation(true);
    await expect(pending).resolves.toBe(false);

    expect(state.chatMessage).toBe("take notes");
    expect(state.chatError).toContain("not sent");
    expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  });

  it("does not send a board /new prompt after reset changes the selected session", async () => {
    const sessions = {
      reset: vi.fn(async () => {
        state.sessionKey = "agent:main:other";
        return "completed" as const;
      }),
    } as unknown as SessionCapability;
    const request = vi.fn();
    const created = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions,
    });
    const state = created.state;
    enableBoardSession(created.pane);

    const pending = created.pane.createSession("take notes");
    await vi.waitFor(() => expect(created.pane.resetConfirmationOpen).toBe(true));
    created.pane.settleResetConfirmation(true);
    await expect(pending).resolves.toBe(false);

    expect(state.chatMessage).toBe("take notes");
    expect(state.chatError).toContain("not sent");
    expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  });

  it("drops a created session after a same-client reconnect", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    advertiseSessionCreate(pane);

    const pending = pane.createSession();
    await vi.waitFor(() => expect(sessions.create).toHaveBeenCalledOnce());
    state.connected = false;
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    state.connected = true;
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    created.resolve("agent:main:new");

    await expect(pending).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not publish a stale creation error after the context is replaced", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, requestUpdate, state } = createTestChatPane({ client, sessions });
    const replacementSessions = {} as SessionCapability;
    advertiseSessionCreate(pane);

    const pending = pane.createSession();
    await vi.waitFor(() => expect(sessions.create).toHaveBeenCalledOnce());
    state.sessionsError = "stale sessions.create failure";
    pane.context = createSessionContext(client, replacementSessions);
    created.resolve(null);

    await expect(pending).resolves.toBe(false);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("does not publish a stale creation error after the pane detaches", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, requestUpdate, state } = createTestChatPane({ client, sessions });
    advertiseSessionCreate(pane);

    const pending = pane.createSession();
    await vi.waitFor(() => expect(sessions.create).toHaveBeenCalledOnce());
    state.sessionsError = "stale sessions.create failure";
    Object.defineProperty(pane, "isConnected", {
      configurable: true,
      value: false,
    });
    created.resolve(null);

    await expect(pending).resolves.toBe(false);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(requestUpdate).not.toHaveBeenCalled();
  });
});
