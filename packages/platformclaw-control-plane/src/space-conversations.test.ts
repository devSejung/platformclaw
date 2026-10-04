import { describe, expect, it, vi } from "vitest";
import type { SpaceConversation } from "./space-contracts.js";
import { projectSpaceRecallResult, validateSpaceRecallWindow } from "./space-recall-projection.js";
import { createSpaceTestFixture as fixture } from "./spaces.test-fixtures.js";

const rpc = "platformclaw.spaces.";
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function create(f: Fixture, actor = f.alice, requestId = "own-tab") {
  return f.proxy.request<SpaceConversation>(actor.token, rpc + "conversation.create", {
    spaceId: f.space.id,
    pageId: f.page.id,
    title: `${actor.token} work`,
    requestId,
  });
}
const textMessage = (role: string, id: string, text: string, ownerId?: string) => ({
  role,
  content: [{ type: "text", text }],
  __openclaw: { id, ...(ownerId ? { senderProfileId: ownerId, senderName: "Alice" } : {}) },
});

describe("Space-created personal conversations", () => {
  it("registers only new personal keys, reopens idempotently, and sends through the native owner path", async () => {
    const f = await fixture();
    const conversation = await create(f);
    expect(conversation).toMatchObject({
      ownerId: f.alice.user.id,
      agentId: f.alice.binding.agentId,
      pageId: f.page.id,
      spaceId: f.space.id,
      canWrite: true,
    });
    expect(conversation.sessionKey).toBe(
      `agent:${f.alice.binding.agentId}:space-session:${conversation.id}`,
    );
    await f.proxy.request(f.alice.token, "chat.send", {
      sessionKey: conversation.sessionKey,
      message: "Investigate the issue",
      idempotencyKey: "native-run",
    });
    expect(f.request).toHaveBeenLastCalledWith(
      "chat.send",
      expect.objectContaining({
        agentId: f.alice.binding.agentId,
        sessionKey: conversation.sessionKey,
        senderAttribution: expect.objectContaining({ profileId: f.alice.user.id }),
        deliver: false,
      }),
    );
    expect(await create(f)).toEqual(conversation);
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.create")).toHaveLength(1);
    await expect(
      f.proxy.request(f.alice.token, rpc + "conversation.create", {
        spaceId: f.space.id,
        pageId: f.page.id,
        title: "import",
        requestId: "outside",
        sessionKey: `agent:${f.alice.binding.agentId}:main`,
      }),
    ).rejects.toThrow("parameter");
    await expect(
      f.proxy.request(f.alice.token, "chat.send", {
        sessionKey: `agent:${f.alice.binding.agentId}:space-session:unregistered`,
        message: "forged",
        idempotencyKey: "forged",
      }),
    ).rejects.toThrow("unavailable");
  });

  it("recovers a lost creation response without reapplying the existing native session", async () => {
    const f = await fixture();
    const original = f.request.getMockImplementation()!;
    let loseResponse = true;
    f.request.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (method === "sessions.create" && loseResponse) {
        loseResponse = false;
        throw new Error("response lost");
      }
      return result;
    });
    await expect(create(f)).rejects.toThrow("response lost");
    const [a, b] = await Promise.all([create(f), create(f)]);
    expect(a).toEqual(b);
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.create")).toHaveLength(1);
  });

  it("exposes only each caller's tabs and native events, never a peer's transcript or approvals", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const alice = await create(f);
    const bob = await create(f, f.bob);
    const listed = await f.proxy.request<{ conversations: SpaceConversation[] }>(
      f.bob.token,
      rpc + "get",
      { spaceId: f.space.id },
    );
    expect(listed.conversations.map((entry) => entry.id)).toEqual([bob.id]);
    const bobParent = {
      key: `agent:${bob.agentId}:main`,
      agentId: bob.agentId,
      childSessions: [alice.sessionKey],
      hasActiveSubagentRun: true,
    };
    const rawBobParent = { ...bobParent, activeChildSessions: [alice.sessionKey] };
    f.request.mockResolvedValueOnce({ sessions: [rawBobParent] });
    await expect(f.proxy.request(f.bob.token, "sessions.list", {})).resolves.toEqual({
      sessions: [{ ...bobParent, childSessions: [], hasActiveSubagentRun: false }],
    });
    await expect(
      f.proxy.filterEvent(f.bob.token, {
        event: "sessions.changed",
        payload: { sessionKey: bobParent.key, ...rawBobParent },
      }),
    ).resolves.toEqual({
      event: "sessions.changed",
      payload: {
        sessionKey: bobParent.key,
        ...bobParent,
        childSessions: [],
        hasActiveSubagentRun: false,
      },
    });
    await expect(
      f.proxy.request(f.bob.token, rpc + "conversation.history", {
        spaceId: f.space.id,
        conversationId: alice.id,
      }),
    ).rejects.toThrow("unavailable");
    for (const method of ["chat.history", "chat.send"] as const) {
      await expect(
        f.proxy.request(f.bob.token, method, {
          sessionKey: alice.sessionKey,
          ...(method === "chat.send" ? { message: "use Alice VM", idempotencyKey: "bad" } : {}),
        }),
      ).rejects.toThrow();
    }
    for (const event of ["agent", "chat", "session.tool", "session.message"] as const) {
      const frame = {
        event,
        payload: {
          sessionKey: alice.sessionKey,
          agentId: alice.agentId,
          command: "private command",
          data: "private output",
        },
      };
      expect(await f.proxy.filterEvent(f.alice.token, frame)).toEqual(frame);
      expect(await f.proxy.filterEvent(f.bob.token, frame)).toBeNull();
    }
    const approval = {
      event: "session.approval",
      payload: {
        sessionKey: alice.sessionKey,
        approval: {
          id: "approval-own",
          presentation: {
            kind: "exec",
            agentId: alice.agentId,
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      },
    };
    expect(await f.proxy.filterEvent(f.alice.token, approval)).toEqual(approval);
    expect(await f.proxy.filterEvent(f.bob.token, approval)).toBeNull();
    await expect(
      f.proxy.request(f.bob.token, "approval.resolve", {
        id: "approval-own",
        kind: "exec",
        decision: "allow-once",
      }),
    ).rejects.toThrow("not bound");
  });

  it("gives member agents only authenticated questions and final answers from registered conversations", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    const conversation = await create(f);
    const messages = [
      textMessage("user", "q", "Why did it fail?", f.alice.user.id),
      {
        ...textMessage("assistant", "a", "The clock configuration was wrong"),
        stopReason: "stop",
      },
      {
        ...textMessage("assistant", "commentary", "Inspecting private files"),
        phase: "commentary",
      },
      { ...textMessage("assistant", "error", "private failure"), stopReason: "error" },
      { ...textMessage("assistant", "aborted", "unfinished private text"), stopReason: "aborted" },
      {
        ...textMessage("assistant", "malformed-stop", "private malformed metadata"),
        stopReason: { reason: "stop" },
      },
      { ...textMessage("assistant", "hidden", "hidden payload"), display: false },
      {
        ...textMessage("assistant", "mirror", "private message tool output"),
        openclawMessageToolMirror: {},
      },
      {
        ...textMessage("assistant", "forward", "outside session output"),
        provenance: { kind: "inter_session" },
      },
      textMessage("user", "synthetic", "runtime context"),
      {
        ...textMessage("assistant", "mixed", "private command preamble"),
        content: [
          { type: "text", text: "private command preamble" },
          { type: "toolCall", name: "exec", arguments: { command: "secret" } },
        ],
      },
      { role: "toolResult", content: "raw token", __openclaw: { id: "tool" } },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          {
            type: "text",
            text: "Signature-only commentary",
            textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
          },
          {
            type: "text",
            text: "Verified final",
            textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
          },
        ],
        stopReason: "length",
        __openclaw: { id: "phases" },
      },
    ];
    f.request.mockResolvedValueOnce({ messages });
    const result = await f.service.agentRead({
      agentId: f.bob.binding.agentId,
      operation: "get",
      spaceId: f.space.id,
      pageId: f.page.id,
      conversationId: conversation.id,
    });
    expect(result).toMatchObject({
      conversation: { id: conversation.id, ownerId: f.alice.user.id },
      messages: [
        { text: "Why did it fail?" },
        { text: "The clock configuration was wrong" },
        { text: "Verified final" },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/private|raw token|outside session|runtime context/);
    await expect(
      f.service.agentRead({
        agentId: f.carol.binding.agentId,
        operation: "get",
        spaceId: f.space.id,
        pageId: f.page.id,
        conversationId: conversation.id,
      }),
    ).rejects.toThrow("unavailable");
  });

  it("builds recall search snippets from final Q&A, not foreign or tool-index hits", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    const conversation = await create(f);
    f.request.mockImplementation(async (method, raw) => {
      const params = raw as Record<string, unknown>;
      if (method === "sessions.search" && params.agentId === conversation.agentId) {
        return {
          results: [
            {
              sessionKey: `agent:${conversation.agentId}:main`,
              messageId: "outside",
              snippet: "outside secret",
            },
            { sessionKey: conversation.sessionKey, messageId: "tool", snippet: "raw tool secret" },
            {
              sessionKey: conversation.sessionKey,
              messageId: "answer",
              snippet: "tainted indexed preview",
            },
          ],
        };
      }
      if (method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: "secret", __openclaw: { id: "tool" } },
            textMessage("assistant", "answer", "clock configured correctly"),
          ],
        };
      }
      return { results: [] };
    });
    const result = await f.service.agentRead({
      agentId: f.bob.binding.agentId,
      operation: "search",
      query: "clock",
      spaceId: f.space.id,
    });
    expect(JSON.stringify(result)).toContain("clock configured correctly");
    expect(JSON.stringify(result)).not.toMatch(/secret|tainted indexed preview|conversation=/);
    expect(f.request).toHaveBeenCalledWith("sessions.search", {
      agentId: conversation.agentId,
      sessionKeys: [conversation.sessionKey],
      query: "clock",
      limit: 25,
    });
    expect(await f.service.search(f.bob.user.id, "clock", f.space.id, async () => {})).toEqual({
      results: [],
      indexing: false,
    });
  });

  it("matches every query term only against shareable final text", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    const conversation = await create(f);
    f.request.mockImplementation(async (method, raw) => {
      const params = raw as Record<string, unknown>;
      if (method === "sessions.search" && params.agentId === conversation.agentId) {
        return { results: [{ sessionKey: conversation.sessionKey, messageId: "mixed" }] };
      }
      return method === "chat.history"
        ? {
            messages: [
              {
                role: "assistant",
                __openclaw: { id: "mixed" },
                content: [
                  {
                    type: "text",
                    text: "hidden hypothesis",
                    textSignature: '{"v":1,"phase":"commentary"}',
                  },
                  {
                    type: "text",
                    text: "clock valid evidence",
                    textSignature: '{"v":1,"phase":"final_answer"}',
                  },
                ],
              },
            ],
          }
        : { results: [] };
    });
    const search = (query: string) =>
      f.service.agentRead({
        agentId: f.bob.binding.agentId,
        operation: "search",
        query,
        spaceId: f.space.id,
      });
    expect(await search("hidden")).toMatchObject({ results: [], count: 0 });
    expect(await search("clock hidden")).toMatchObject({ results: [], count: 0 });
    expect(await search("CLOCK evidence")).toMatchObject({
      count: 1,
      results: [{ snippet: "clock valid evidence" }],
    });
  });

  it.each([false, true])(
    "bounds lookup fan-out across agents and Spaces (separate Space: %s)",
    async (separateSpace) => {
      const f = await fixture();
      const first = await create(f);
      let second: SpaceConversation;
      if (separateSpace) {
        const space = f.store.spaces.create(f.alice.user.id, "Other", "bounded-other");
        const page = f.store.spaces.createPage(f.alice.user.id, space.id, {
          title: "Other page",
          body: "",
          requestId: "bounded-page",
        });
        second = await f.proxy.request<SpaceConversation>(
          f.alice.token,
          rpc + "conversation.create",
          {
            spaceId: space.id,
            pageId: page.id,
            title: "Other work",
            requestId: "bounded-tab",
          },
        );
      } else {
        f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
        second = await create(f, f.bob, "bob-tab");
      }
      const conversations = [first, second];
      f.request.mockClear();
      f.request.mockImplementation(async (method, raw) => {
        const params = raw as Record<string, unknown>;
        const conversation = conversations.find((entry) =>
          method === "sessions.search"
            ? Array.isArray(params.sessionKeys) && params.sessionKeys.includes(entry.sessionKey)
            : params.sessionKey === entry.sessionKey,
        );
        if (!conversation) {
          return { results: [] };
        }
        const messages = Array.from({ length: 25 }, (_, index) => ({
          ...textMessage("assistant", `commentary-${index}`, "clock internal progress"),
          phase: "commentary",
        }));
        return method === "sessions.search"
          ? {
              results: messages.map((message) => ({
                sessionKey: conversation.sessionKey,
                messageId: message["__openclaw"].id,
              })),
            }
          : { messages };
      });
      const result = await f.service.agentRead({
        agentId: f.alice.binding.agentId,
        operation: "search",
        query: "clock",
      });
      expect(result).toMatchObject({ results: [], count: 0, windowLimited: true, truncated: true });
      expect(f.request).toHaveBeenCalledTimes(40);
      expect(JSON.stringify(result)).not.toContain("internal progress");
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(8 * 1024);
    },
  );

  it("finds final Q&A beyond the first ten indexed commentary hits", async () => {
    const f = await fixture();
    const conversation = await create(f);
    const messages = [
      ...Array.from({ length: 10 }, (_, index) => ({
        ...textMessage("assistant", `commentary-${index}`, "clock internal progress"),
        phase: "commentary",
      })),
      textMessage("assistant", "final", "clock final evidence"),
    ];
    f.request.mockImplementation(async (method, raw) => {
      const params = raw as Record<string, unknown>;
      if (method === "sessions.search" && params.agentId === conversation.agentId) {
        return {
          results: messages.slice(0, Number(params.limit)).map((message) => ({
            sessionKey: conversation.sessionKey,
            messageId: message["__openclaw"].id,
          })),
          truncated: Number(params.limit) < messages.length,
        };
      }
      return method === "chat.history" ? { messages } : { results: [] };
    });
    const result = await f.service.agentRead({
      agentId: conversation.agentId,
      operation: "search",
      query: "clock",
      spaceId: f.space.id,
    });
    expect(result).toMatchObject({
      count: 1,
      windowLimited: true,
      results: [{ snippet: "clock final evidence" }],
    });
    expect(JSON.stringify(result)).not.toContain("internal progress");
  });

  it.each(["personal", "legacy"])(
    "preserves a truncated %s index window after filtering all hits",
    async (kind) => {
      const f = await fixture();
      const conversation = await create(f);
      const agentId = kind === "personal" ? conversation.agentId : f.space.agentId;
      f.request.mockImplementation(async (method, raw) => {
        const params = raw as Record<string, unknown>;
        return method === "sessions.search" && params.agentId === agentId
          ? { results: [], truncated: true }
          : { results: [] };
      });
      const result = await f.service.agentRead({
        agentId: conversation.agentId,
        operation: "search",
        query: "clock",
        spaceId: f.space.id,
      });
      expect(result).toMatchObject({
        results: [],
        count: 0,
        moreAvailable: false,
        truncated: true,
        windowLimited: true,
      });
      expect(result.guidance).toContain("narrow the query");
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(8 * 1024);
    },
  );

  it("does not disclose hidden-only index matches through completeness metadata", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    const conversation = await create(f);
    let hiddenMatches = true;
    const messages = Array.from({ length: 25 }, (_, index) => ({
      ...textMessage("assistant", `hidden-${index}`, "confidential hypothesis"),
      phase: "commentary",
    }));
    f.request.mockImplementation(async (method, raw) => {
      const params = raw as Record<string, unknown>;
      if (method === "sessions.search" && params.agentId === conversation.agentId) {
        return hiddenMatches
          ? {
              results: messages.map((message) => ({
                sessionKey: conversation.sessionKey,
                messageId: message["__openclaw"].id,
              })),
              truncated: true,
            }
          : { results: [], truncated: false };
      }
      return method === "chat.history" ? { messages } : { results: [] };
    });
    const search = () =>
      f.service.agentRead({
        agentId: f.bob.binding.agentId,
        operation: "search",
        query: "confidential",
        spaceId: f.space.id,
      });
    const hidden = await search();
    hiddenMatches = false;
    expect(await search()).toEqual(hidden);
    expect(hidden).toMatchObject({ results: [], count: 0, windowLimited: true });
  });

  it("scopes a registered running session to its Space and preserves peer recall after the creator leaves", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const conversation = await create(f);
    const other = f.store.spaces.create(f.alice.user.id, "Other", "other-space");
    await expect(
      f.service.agentRead({
        agentId: conversation.agentId,
        sessionKey: conversation.sessionKey,
        operation: "search",
        spaceId: other.id,
        query: "secret",
      }),
    ).rejects.toThrow("unavailable");
    expect(
      await f.service.agentRead({
        agentId: conversation.agentId,
        sessionKey: conversation.sessionKey,
        operation: "context",
      }),
    ).toMatchObject({ spaceName: "PMU", conversation: { id: conversation.id } });
    await f.proxy.request(f.bob.token, rpc + "member.remove", {
      spaceId: f.space.id,
      userId: f.alice.user.id,
      expectedRevision: 2,
    });
    expect(f.request).toHaveBeenCalledWith("sessions.abort", {
      key: conversation.sessionKey,
      agentId: conversation.agentId,
      clearQueued: true,
    });
    await expect(
      f.proxy.request(f.alice.token, "chat.history", { sessionKey: conversation.sessionKey }),
    ).rejects.toThrow("unavailable");
    await expect(
      f.service.agentRead({
        agentId: conversation.agentId,
        sessionKey: conversation.sessionKey,
        operation: "context",
      }),
    ).rejects.toThrow("unavailable");
    f.request.mockResolvedValueOnce({
      messages: [textMessage("assistant", "retained", "Retained answer")],
    });
    expect(
      await f.service.agentRead({
        agentId: f.bob.binding.agentId,
        operation: "get",
        spaceId: f.space.id,
        pageId: f.page.id,
        conversationId: conversation.id,
      }),
    ).toMatchObject({ messages: [{ text: "Retained answer" }] });
  });

  it("allows an own Viewer to read but denies writes, replayed approvals, destructive changes and new creation", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const conversation = await create(f);
    await f.proxy.filterEvent(f.alice.token, {
      event: "session.approval",
      payload: {
        sessionKey: conversation.sessionKey,
        approval: {
          id: "pending",
          presentation: {
            kind: "exec",
            agentId: conversation.agentId,
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      },
    });
    for (const method of ["sessions.delete", "sessions.reset", "sessions.create"] as const) {
      await expect(
        f.proxy.request(f.alice.token, method, { key: conversation.sessionKey }),
      ).rejects.toThrow("retained");
    }
    await f.proxy.request(f.bob.token, rpc + "member.set", {
      spaceId: f.space.id,
      userId: f.alice.user.id,
      role: "viewer",
      expectedRevision: 2,
    });
    const raw = { messages: [{ role: "toolResult", content: "Own raw historical output" }] };
    f.request.mockResolvedValueOnce(raw);
    expect(
      await f.proxy.request(f.alice.token, rpc + "conversation.history", {
        spaceId: f.space.id,
        conversationId: conversation.id,
      }),
    ).toMatchObject({ ...raw, conversation: { canWrite: false } });
    await expect(
      f.proxy.request(f.alice.token, "chat.send", {
        sessionKey: conversation.sessionKey,
        message: "still run",
        idempotencyKey: "after-demotion",
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      f.proxy.request(f.alice.token, "approval.resolve", {
        id: "pending",
        kind: "exec",
        decision: "allow-once",
      }),
    ).rejects.toThrow("not bound");
    await expect(create(f, f.alice, "new-after-demotion")).rejects.toThrow("unavailable");
  });

  it("pages an own Viewer's retained history through the bounded native contract", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const conversation = await create(f);
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, "viewer", 2);
    const history = (params: Record<string, unknown> = {}, token = f.alice.token) =>
      f.proxy.request(token, rpc + "conversation.history", {
        spaceId: f.space.id,
        conversationId: conversation.id,
        ...params,
      });
    const first = {
      sessionKey: conversation.sessionKey,
      sessionId: "retained-transcript",
      messages: [textMessage("assistant", "newer", "Latest answer")],
      offset: 0,
      hasMore: true,
      nextOffset: 100,
      totalMessages: 101,
    };
    f.request.mockResolvedValueOnce(first);
    expect(await history()).toMatchObject({ ...first, conversation: { canWrite: false } });
    const older = {
      sessionKey: conversation.sessionKey,
      sessionId: first.sessionId,
      messages: [textMessage("assistant", "older", "Older answer")],
      offset: 100,
      hasMore: false,
      totalMessages: first.totalMessages,
    };
    f.request.mockResolvedValueOnce(older);
    const olderPage = await history({ offset: 100 });
    expect(olderPage).toMatchObject(older);
    expect(olderPage).not.toHaveProperty("nextOffset");
    expect(f.request).toHaveBeenLastCalledWith("chat.history", {
      agentId: conversation.agentId,
      sessionKey: conversation.sessionKey,
      limit: 100,
      offset: 100,
    });
    const calls = f.request.mock.calls.length;
    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "100"]) {
      await expect(history({ offset })).rejects.toThrow("offset");
    }
    await expect(history({ offset: 0, messageId: "older" })).rejects.toThrow("offset");
    await expect(history({ offset: 100, sessionId: first.sessionId })).rejects.toThrow("parameter");
    await expect(history({ offset: 100 }, f.bob.token)).rejects.toThrow("unavailable");
    expect(f.request).toHaveBeenCalledTimes(calls);
  });

  it.each(["membership", "binding"])(
    "revalidates %s before returning an older owner-history page",
    async (changed) => {
      const f = await fixture();
      f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
      const conversation = await create(f);
      f.request.mockImplementationOnce(async () => {
        if (changed === "membership") {
          f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
        } else {
          await f.store.transitionAgent({
            bindingId: f.alice.binding.id,
            state: "disabled",
            changedAt: Date.now(),
          });
        }
        return { messages: [textMessage("assistant", "older", "Older answer")], hasMore: false };
      });
      await expect(
        f.proxy.request(f.alice.token, rpc + "conversation.history", {
          spaceId: f.space.id,
          conversationId: conversation.id,
          offset: 100,
        }),
      ).rejects.toThrow(changed === "membership" ? "unavailable" : "active personal agent");
    },
  );

  it("cancels a native send admitted during membership revocation", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const conversation = await create(f);
    const original = f.request.getMockImplementation()!;
    let release!: () => void;
    f.request.mockImplementation(async (method, params) => {
      if (method === "chat.send") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: "started" };
      }
      return original(method, params);
    });
    const sending = f.proxy.request(f.alice.token, "chat.send", {
      sessionKey: conversation.sessionKey,
      message: "run",
      idempotencyKey: "race",
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
    release();
    await expect(sending).rejects.toThrow("unavailable");
    expect(f.request).toHaveBeenLastCalledWith("chat.abort", {
      sessionKey: conversation.sessionKey,
      agentId: conversation.agentId,
      runId: "race",
    });
    expect(
      await f.proxy.filterEvent(f.alice.token, {
        event: "chat",
        payload: {
          sessionKey: conversation.sessionKey,
          message: { content: "after revoke" },
        },
      }),
    ).toBeNull();
  });

  it("fences a pending old admission after remove and re-add without cancelling a newer run", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const conversation = await create(f);
    const original = f.request.getMockImplementation()!;
    let release!: () => void;
    f.request.mockImplementation(async (method, params) => {
      if (
        method === "chat.send" &&
        (params as { idempotencyKey?: string }).idempotencyKey === "old-admission"
      ) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: "started", runId: "old-admission" };
      }
      return original(method, params);
    });
    const old = f.proxy.request(f.alice.token, "chat.send", {
      sessionKey: conversation.sessionKey,
      message: "old",
      idempotencyKey: "old-admission",
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, "editor", 3);
    await f.proxy.request(f.alice.token, "chat.send", {
      sessionKey: conversation.sessionKey,
      message: "new authorization",
      idempotencyKey: "new-admission",
    });
    release();
    await expect(old).rejects.toThrow("membership changed");
    expect(f.request).toHaveBeenLastCalledWith("chat.abort", {
      sessionKey: conversation.sessionKey,
      agentId: conversation.agentId,
      runId: "old-admission",
    });
    expect(f.request).not.toHaveBeenCalledWith("sessions.abort", expect.anything());
  });

  it.each(["creation", "history", "recall"] as const)(
    "rejects %s results completed after access removal",
    async (operation) => {
      const f = await fixture();
      f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
      const conversation = await create(f);
      const original = f.request.getMockImplementation()!;
      let release!: () => void;
      f.request.mockImplementation(async (method, params) => {
        if (method === (operation === "creation" ? "sessions.resolve" : "chat.history")) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return operation === "creation"
            ? { ok: true, key: conversation.sessionKey }
            : { messages: [textMessage("assistant", "late", "late private result")] };
        }
        return original(method, params);
      });
      const pending =
        operation === "creation"
          ? create(f)
          : operation === "history"
            ? f.proxy.request(f.alice.token, "chat.history", {
                sessionKey: conversation.sessionKey,
              })
            : f.service.agentRead({
                agentId: f.alice.binding.agentId,
                operation: "get",
                spaceId: f.space.id,
                pageId: f.page.id,
                conversationId: conversation.id,
              });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
      release();
      await expect(pending).rejects.toThrow("unavailable");
    },
  );

  it("fails closed if runtime authorization hooks are unavailable", async () => {
    const f = await fixture(false);
    await expect(create(f)).rejects.toThrow("internal agent service");
    expect(f.store.spaces.conversations(f.alice.user.id, f.space.id)).toEqual([]);
  });

  it("authorizes native targets before recall projection and never grants a peer raw history", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const conversation = await create(f);
    expect(
      await f.service.agentRead({
        agentId: conversation.agentId,
        sessionKey: conversation.sessionKey,
        operation: "native",
        nativeTool: "sessions_history",
        targetSessionKey: "current",
        broad: false,
      }),
    ).toEqual({ sessionKey: conversation.sessionKey });
    await expect(
      f.service.agentRead({
        agentId: f.bob.binding.agentId,
        sessionKey: `agent:${f.bob.binding.agentId}:main`,
        operation: "native",
        nativeTool: "sessions_history",
        targetSessionKey: conversation.sessionKey,
        broad: true,
      }),
    ).rejects.toThrow("unavailable");
  });

  it("keeps native compaction on the same personal session while retaining shared history", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const conversation = await create(f);
    f.request.mockResolvedValueOnce({ compacted: true, key: conversation.sessionKey });
    expect(
      await f.proxy.request(f.alice.token, "sessions.compact", { key: conversation.sessionKey }),
    ).toMatchObject({ compacted: true });
    expect(f.request).toHaveBeenLastCalledWith("sessions.compact", {
      key: conversation.sessionKey,
      agentId: conversation.agentId,
    });
    await expect(
      f.proxy.request(f.alice.token, "sessions.compaction.restore", {
        key: conversation.sessionKey,
        checkpointId: "before",
      }),
    ).rejects.toThrow("retained");
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, "viewer", 2);
    await expect(
      f.proxy.request(f.alice.token, "sessions.compact", { key: conversation.sessionKey }),
    ).rejects.toThrow("unavailable");
  });

  it("bounds multibyte recall envelopes and exposes continuations without accumulating pages", async () => {
    const f = await fixture();
    const conversation = await create(f);
    const body = '한글😀"\\\n'.repeat(1500);
    const page = f.store.spaces.savePage(
      f.alice.user.id,
      f.space.id,
      f.page.id,
      "Large source",
      body,
      1,
    );
    const answer = '한글😀"\\\n'.repeat(1000);
    f.request.mockImplementation(async (method) =>
      method === "chat.history"
        ? {
            messages: Array.from({ length: 30 }, (_, i) =>
              textMessage("assistant", `message-${i}`, answer),
            ),
          }
        : { results: [] },
    );
    const result = await f.service.agentRead({
      agentId: conversation.agentId,
      operation: "get",
      spaceId: f.space.id,
      pageId: page.id,
      conversationId: conversation.id,
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16 * 1024);
    const expanded = await f.service.agentRead({
      agentId: conversation.agentId,
      operation: "get",
      spaceId: f.space.id,
      pageId: page.id,
      conversationId: conversation.id,
      limit: 8,
      bodyLimitBytes: 8000,
    });
    expect(Buffer.byteLength(JSON.stringify(expanded), "utf8")).toBeLessThanOrEqual(24 * 1024);
    expect(expanded.messages).toHaveLength(8);
    const projectedPage = result.page as { body: string; nextBodyOffset: number; revision: number };
    expect(projectedPage.nextBodyOffset).toBe(projectedPage.body.length);
    expect(body.startsWith(projectedPage.body)).toBe(true);
    expect(Buffer.from(projectedPage.body, "utf8").toString("utf8")).toBe(projectedPage.body);
    const messages = result.messages as Array<{
      id: string;
      text: string;
      nextMessageOffset: number;
    }>;
    expect(messages).toHaveLength(5);
    expect(
      messages.every(
        (message) => Buffer.from(message.text, "utf8").toString("utf8") === message.text,
      ),
    ).toBe(true);
    expect(result.moreAvailable).toBe(true);
    const first = messages[0]!;
    const next = await f.service.agentRead({
      agentId: conversation.agentId,
      operation: "get",
      spaceId: f.space.id,
      pageId: page.id,
      conversationId: conversation.id,
      messageId: first.id,
      messageOffset: first.nextMessageOffset,
      bodyOffset: projectedPage.nextBodyOffset,
      pageRevision: page.revision,
    });
    const nextPage = next.page as { body: string; bodyOffset: number };
    expect(body.slice(nextPage.bodyOffset).startsWith(nextPage.body)).toBe(true);
    const nextMessages = next.messages as Array<{ text: string; messageOffset: number }>;
    expect(nextMessages).toHaveLength(1);
    expect(answer.slice(nextMessages[0]!.messageOffset).startsWith(nextMessages[0]!.text)).toBe(
      true,
    );
    const results = Array.from({ length: 20 }, (_, index) => ({
      spaceId: "space",
      pageId: `page-${index}`,
      pageTitle: "제목".repeat(80),
      snippet: answer,
      link: `/spaces?space=space&page=page-${index}`,
    }));
    const search = projectSpaceRecallResult({ results }, { operation: "search" });
    expect(Buffer.byteLength(JSON.stringify(search), "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(search.count).toBeLessThanOrEqual(5);
    expect(search.moreAvailable).toBe(true);
    expect(search.nextCursor).toBe(String(search.count));
    const larger = projectSpaceRecallResult(
      { results },
      { operation: "search", limit: 20, cursor: String(search.count) },
    );
    expect(Buffer.byteLength(JSON.stringify(larger), "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(larger.windowLimited).toBe(true);
    expect(() => validateSpaceRecallWindow({ operation: "get", messageOffset: 3 })).toThrow(
      "window",
    );
    expect(() =>
      projectSpaceRecallResult(
        {
          page: { body: "", bodyOffset: 0 },
          messages: [{ id: "emoji", text: "😀text" }],
        },
        { operation: "get", messageId: "emoji", messageOffset: 1 },
      ),
    ).toThrow("Unicode");
    const emojiPage = f.store.spaces.savePage(
      f.alice.user.id,
      f.space.id,
      f.page.id,
      "Unicode",
      "😀text",
      page.revision,
    );
    await expect(
      f.service.agentRead({
        agentId: conversation.agentId,
        operation: "get",
        spaceId: f.space.id,
        pageId: emojiPage.id,
        bodyOffset: 1,
        pageRevision: emojiPage.revision,
      }),
    ).rejects.toThrow("Unicode");
  });
});
