import type { EventFrame } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserGatewayEventForwarder,
  createBrowserGatewayEventSender,
} from "./browser-gateway-event-forwarder.js";
import type { SpaceConversation } from "./space-contracts.js";
import { createSpaceTestFixture as fixture } from "./spaces.test-fixtures.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

function browser(f: Fixture, token: string) {
  const frames: EventFrame[] = [];
  const closeUnauthorized = vi.fn();
  const connectionId = `compaction-${token}`;
  f.proxy.registerBrowserConnection(connectionId);
  const forward = createBrowserGatewayEventForwarder({
    connectionId,
    token,
    proxy: f.proxy,
    isConnected: () => true,
    sendEvent: createBrowserGatewayEventSender((frame) => frames.push(frame)),
    closeUnauthorized,
  });
  return { frames, forward, closeUnauthorized };
}

function compaction(
  agentId: string,
  sessionKey: string,
  phase: "start" | "end",
  seq: number,
): EventFrame {
  return {
    type: "event",
    event: "agent",
    payload: {
      agentId,
      sessionKey,
      runId: `run-${agentId}`,
      seq,
      stream: "compaction",
      data: { phase, itemId: `item-${agentId}`, ...(phase === "end" ? { completed: true } : {}) },
    },
  };
}

describe("employee compaction boundary", () => {
  it("preserves live/history identity and savings for two employees without cross-delivery", async () => {
    const f = await fixture();
    const alice = browser(f, f.alice.token);
    const bob = browser(f, f.bob.token);
    const actors = [f.alice, f.bob];
    const browsers = [alice, bob];
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      const values = params as { sessionKey?: string; key?: string; agentId?: string };
      if (method === "sessions.compact") {
        return {
          key: values.key,
          compacted: true,
          result: { tokensBefore: 900_000, tokensAfter: 24_700 },
        };
      }
      if (method === "chat.history" || method === "chat.startup") {
        return {
          sessionKey: values.sessionKey,
          messages: [
            {
              role: "system",
              content: [],
              __openclaw: {
                kind: "compaction",
                id: `entry-${values.agentId}`,
                runId: `run-${values.agentId}`,
                itemId: `item-${values.agentId}`,
                tokensBefore: 900_000,
                tokensAfter: 24_700,
              },
            },
          ],
          agentsList: {
            defaultId: values.agentId,
            agents: actors.map(({ binding }) => ({ id: binding.agentId })),
          },
        };
      }
      return original(method, params);
    });

    for (const [index, actor] of actors.entries()) {
      const agentId = actor.binding.agentId;
      const sessionKey = `agent:${agentId}:main`;
      const events = [
        compaction(agentId, sessionKey, "start", 3),
        compaction(agentId, sessionKey, "end", 8),
      ];
      for (const event of events) {
        await Promise.all(browsers.map(({ forward }) => forward(event)));
      }
      expect(browsers[index].frames).toEqual(
        events.map((event, seq) => ({ ...event, seq: seq + 1 })),
      );
      await expect(
        f.proxy.request(actor.token, "sessions.compact", { key: sessionKey }),
      ).resolves.toEqual({
        compacted: true,
        result: { tokensBefore: 900_000, tokensAfter: 24_700 },
      });
      for (const method of ["chat.history", "chat.startup"]) {
        const history = await f.proxy.request<{ messages: unknown[] }>(actor.token, method, {
          sessionKey,
        });
        expect(history.messages).toEqual([
          {
            role: "system",
            content: [],
            __openclaw: {
              kind: "compaction",
              id: `entry-${agentId}`,
              runId: `run-${agentId}`,
              itemId: `item-${agentId}`,
              tokensBefore: 900_000,
              tokensAfter: 24_700,
            },
          },
        ]);
      }
      const peer = actors[1 - index];
      await expect(
        f.proxy.request(peer.token, "chat.history", { sessionKey }),
      ).rejects.toMatchObject({ code: "cross-agent-denied" });
      await expect(
        f.proxy.request(peer.token, "sessions.compact", { key: sessionKey }),
      ).rejects.toMatchObject({ code: "cross-agent-denied" });
    }
    expect(alice.frames).toHaveLength(2);
    expect(bob.frames).toHaveLength(2);
    expect(alice.closeUnauthorized).not.toHaveBeenCalled();
    expect(bob.closeUnauthorized).not.toHaveBeenCalled();
  });

  it("fences pending sends and compaction completion after Space membership revocation", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const conversation = await f.proxy.request<SpaceConversation>(
      f.alice.token,
      "platformclaw.spaces.conversation.create",
      {
        spaceId: f.space.id,
        pageId: f.page.id,
        title: "Compaction",
        requestId: "compaction-tab",
      },
    );
    const alice = browser(f, f.alice.token);
    const bob = browser(f, f.bob.token);
    const start = compaction(conversation.agentId, conversation.sessionKey, "start", 1);
    await Promise.all([alice.forward(start), bob.forward(start)]);
    expect(alice.frames).toHaveLength(1);
    expect(bob.frames).toHaveLength(0);

    const original = f.request.getMockImplementation()!;
    let release: (() => void) | undefined;
    f.request.mockImplementation(async (method, params) => {
      if (method === "chat.send") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: "started", runId: "queued-during-compaction" };
      }
      return original(method, params);
    });
    const sending = f.proxy.request(f.alice.token, "chat.send", {
      sessionKey: conversation.sessionKey,
      message: "Continue after compaction",
      idempotencyKey: "queued-during-compaction",
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(f.request).toHaveBeenLastCalledWith(
      "chat.send",
      expect.objectContaining({
        senderAttribution: expect.objectContaining({ profileId: f.alice.user.id }),
        idempotencyKey: "queued-during-compaction",
        agentId: conversation.agentId,
      }),
    );
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
    const end = compaction(conversation.agentId, conversation.sessionKey, "end", 2);
    await Promise.all([alice.forward(end), bob.forward(end)]);
    await alice.forward({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: conversation.sessionKey,
        runId: "queued-during-compaction",
        state: "final",
        message: { role: "assistant", content: "late output" },
      },
    });
    release!();
    await expect(sending).rejects.toThrow("unavailable");
    expect(f.request).toHaveBeenLastCalledWith("chat.abort", {
      sessionKey: conversation.sessionKey,
      agentId: conversation.agentId,
      runId: "queued-during-compaction",
    });
    expect(f.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(alice.frames).toHaveLength(1);
    expect(bob.frames).toHaveLength(0);
  });
});
