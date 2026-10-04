// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import {
  applyChatSelectedSessionSnapshot,
  captureChatSelectedSessionRequest,
  clearChatSelectedSessionSnapshot,
  readChatSelectedSessionSnapshot,
  syncChatSelectedSessionSnapshot,
} from "./chat-selected-session-snapshot.ts";
import { resolveChatSubagentWait } from "./chat-subagent-wait.ts";

const parent: GatewaySessionRow = {
  key: "agent:main:parent",
  kind: "direct",
  updatedAt: 1,
  status: "running",
  hasActiveRun: false,
  hasActiveSubagentRun: true,
};

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

type Host = Parameters<typeof applyChatSelectedSessionSnapshot>[0];

function createHost(request = vi.fn()): Host {
  return {
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    connectionEpoch: 1,
    sessionKey: parent.key,
    assistantAgentId: "main",
    requestUpdate: vi.fn(),
  };
}

function waits(host: Host): boolean {
  return (
    resolveChatSubagentWait({
      selectedSession: readChatSelectedSessionSnapshot(host),
      messages: [],
    }) !== null
  );
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("selected-pane session snapshot", () => {
  it("follows real coalesced session refreshes without applying the bounded transcript", async () => {
    vi.useFakeTimers();
    let active = true;
    let listener: ((event: GatewayEventFrame) => void) | undefined;
    const transcript = [{ role: "user", content: "Keep this complete transcript" }];
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [{ key: "agent:main:subagent:child", kind: "direct", updatedAt: 2 }],
        };
      }
      if (method === "chat.history") {
        return {
          sessionInfo: { ...parent, hasActiveSubagentRun: active },
          messages: [{ role: "assistant", content: "Truncated response" }],
          hasMore: true,
          inFlightRun: { runId: "unrelated" },
        };
      }
      throw new Error(`Unexpected request ${method}`);
    });
    const host = Object.assign(createHost(request), { chatMessages: transcript, chatRunId: null });
    const sessions = createSessionCapability({
      snapshot: {
        client: host.client,
        phase: "connected",
        sessionKey: parent.key,
        hello: null,
      },
      subscribe: () => () => {},
      subscribeEvents(next) {
        listener = next;
        return () => {};
      },
    });
    const unsubscribe = sessions.subscribe((next) => {
      syncChatSelectedSessionSnapshot(
        host,
        next.result?.sessions.find((row) => row.key === host.sessionKey),
        sessions.canonicalListRevision,
      );
    });
    try {
      applyChatSelectedSessionSnapshot(host, parent);
      await sessions.refresh({ force: true });
      await settle();
      expect(waits(host)).toBe(true);
      active = false;
      for (let i = 0; i < 3; i += 1) {
        listener?.({
          type: "event",
          event: "sessions.changed",
          payload: {
            sessionKey: "agent:main:subagent:child",
            parentSessionKey: parent.key,
            reason: "subagent-status",
            hasActiveRun: false,
          },
        });
      }
      await vi.advanceTimersByTimeAsync(200);
      expect(waits(host)).toBe(false);
      expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(2);
      expect(host.chatMessages).toBe(transcript);
      expect(host.chatRunId).toBeNull();
    } finally {
      unsubscribe();
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("retains history truth across capped list replacement and clears on the child-settle snapshot", async () => {
    const response = deferred<{ sessionInfo: GatewaySessionRow }>();
    const request = vi.fn(() => response.promise);
    const host = createHost(request);
    const historyRequest = captureChatSelectedSessionRequest(host);
    applyChatSelectedSessionSnapshot(host, parent, historyRequest);
    syncChatSelectedSessionSnapshot(host, parent, 1);

    syncChatSelectedSessionSnapshot(host, undefined, 2);
    syncChatSelectedSessionSnapshot(host, undefined, 2);
    expect(waits(host)).toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith("chat.history", {
      sessionKey: parent.key,
      agentId: "main",
      limit: 1,
      maxChars: 1,
    });

    response.resolve({ sessionInfo: { ...parent, hasActiveSubagentRun: false } });
    await settle();
    expect(waits(host)).toBe(false);
    expect(host.requestUpdate).toHaveBeenCalledOnce();
  });

  it("does not request unadmitted sessions or sessions already in the canonical list", () => {
    const request = vi.fn();
    const host = createHost(request);
    syncChatSelectedSessionSnapshot(host, undefined, 1);
    syncChatSelectedSessionSnapshot(host, parent, 2);
    syncChatSelectedSessionSnapshot(host, parent, 3);
    expect(request).not.toHaveBeenCalled();
    expect(waits(host)).toBe(true);
  });

  it.each([false, true])("honors authoritative own-run activity %s", async (hasActiveRun) => {
    const request = vi.fn(async () => ({ sessionInfo: { ...parent, hasActiveRun } }));
    const host = createHost(request);
    applyChatSelectedSessionSnapshot(host, parent);
    syncChatSelectedSessionSnapshot(host, undefined, 1);
    await settle();
    expect(waits(host)).toBe(!hasActiveRun);
  });

  it("uses the selected agent for a nondefault global pane", async () => {
    const global = { ...parent, key: "global" };
    const request = vi.fn(async () => ({ sessionInfo: global }));
    const host = createHost(request);
    host.sessionKey = "global";
    host.assistantAgentId = "other";
    host.agentsList = { defaultId: "main", scope: "global" };
    applyChatSelectedSessionSnapshot(host, global);
    syncChatSelectedSessionSnapshot(host, undefined, 1);
    await settle();
    expect(request).toHaveBeenCalledExactlyOnceWith("chat.history", {
      sessionKey: "global",
      agentId: "other",
      limit: 1,
      maxChars: 1,
    });
    expect(waits(host)).toBe(true);
  });

  it("coalesces refreshes arriving during a request and rejects the superseded sample", async () => {
    const first = deferred<{ sessionInfo: GatewaySessionRow }>();
    const second = deferred<{ sessionInfo: GatewaySessionRow }>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const host = createHost(request);
    applyChatSelectedSessionSnapshot(host, parent);
    syncChatSelectedSessionSnapshot(host, undefined, 1);
    syncChatSelectedSessionSnapshot(host, undefined, 2);
    syncChatSelectedSessionSnapshot(host, undefined, 3);
    expect(request).toHaveBeenCalledTimes(1);
    first.resolve({ sessionInfo: { ...parent, hasActiveSubagentRun: false } });
    await settle();
    expect(waits(host)).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    second.resolve({ sessionInfo: { ...parent, hasActiveSubagentRun: false } });
    await settle();
    expect(waits(host)).toBe(false);
  });

  it.each(["route", "connection", "disconnect", "delete", "reset", "agent"])(
    "rejects pending reads after %s identity retirement",
    async (retirement) => {
      const response = deferred<{ sessionInfo: GatewaySessionRow }>();
      const host = createHost(vi.fn(() => response.promise));
      if (retirement === "agent") {
        host.sessionKey = "global";
        host.agentsList = { defaultId: "main", scope: "global" };
      }
      const selected = retirement === "agent" ? { ...parent, key: "global" } : parent;
      applyChatSelectedSessionSnapshot(host, selected);
      syncChatSelectedSessionSnapshot(host, undefined, 1);
      if (retirement === "route") {
        clearChatSelectedSessionSnapshot(host);
        host.sessionKey = "agent:main:other";
        host.sessionKey = parent.key;
      } else if (retirement === "connection") {
        host.connectionEpoch += 1;
      } else if (retirement === "disconnect") {
        host.connected = false;
      } else if (retirement === "agent") {
        host.assistantAgentId = "other";
      } else {
        clearChatSelectedSessionSnapshot(host);
      }
      response.resolve({ sessionInfo: selected });
      await settle();
      expect(readChatSelectedSessionSnapshot(host)).toBeUndefined();
      expect(host.requestUpdate).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "denied"])("clears stale wait on a %s response", async (result) => {
    const response = deferred<{ sessionInfo: GatewaySessionRow | null }>();
    const host = createHost(vi.fn(() => response.promise));
    applyChatSelectedSessionSnapshot(host, parent);
    syncChatSelectedSessionSnapshot(host, undefined, 1);
    if (result === "missing") {
      response.resolve({ sessionInfo: null });
    } else {
      response.reject(new Error("FORBIDDEN"));
    }
    await settle();
    expect(waits(host)).toBe(false);
  });

  it("does not let an older read overwrite a newer pushed or canonical row", async () => {
    const response = deferred<{ sessionInfo: GatewaySessionRow }>();
    const host = createHost(vi.fn(() => response.promise));
    applyChatSelectedSessionSnapshot(host, parent);
    syncChatSelectedSessionSnapshot(host, undefined, 1);
    const settled = { ...parent, hasActiveSubagentRun: false };
    // The parent timestamp need not change when one of its children settles.
    applyChatSelectedSessionSnapshot(host, settled);
    response.resolve({ sessionInfo: parent });
    await settle();
    expect(readChatSelectedSessionSnapshot(host)).toBe(settled);
    expect(waits(host)).toBe(false);
  });

  it("does not let a pre-refresh history response resurrect a stale wait", async () => {
    const response = deferred<{ sessionInfo: GatewaySessionRow }>();
    const host = createHost(vi.fn(() => response.promise));
    applyChatSelectedSessionSnapshot(host, parent);
    const oldHistory = captureChatSelectedSessionRequest(host);
    syncChatSelectedSessionSnapshot(host, undefined, 1);
    response.resolve({ sessionInfo: { ...parent, hasActiveSubagentRun: false } });
    await settle();
    applyChatSelectedSessionSnapshot(host, parent, oldHistory);
    expect(waits(host)).toBe(false);
  });

  it("keeps two selected panes independent", async () => {
    const first = deferred<{ sessionInfo: GatewaySessionRow }>();
    const second = deferred<{ sessionInfo: GatewaySessionRow }>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const left = createHost(request);
    const right = { ...createHost(request), sessionKey: "agent:main:other" };
    const other = { ...parent, key: right.sessionKey };
    applyChatSelectedSessionSnapshot(left, parent);
    applyChatSelectedSessionSnapshot(right, other);
    syncChatSelectedSessionSnapshot(left, undefined, 1);
    syncChatSelectedSessionSnapshot(right, undefined, 1);
    first.resolve({ sessionInfo: { ...parent, hasActiveSubagentRun: false } });
    second.resolve({ sessionInfo: other });
    await settle();
    expect(waits(left)).toBe(false);
    expect(waits(right)).toBe(true);
  });
});
