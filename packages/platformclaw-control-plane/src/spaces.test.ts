import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createSpaceTestFixture as fixture } from "./spaces.test-fixture.js";
import { PlatformClawWebIngressServer } from "./web-ingress-server.js";
import { createFrameQueue, FakeGateway, isRecord } from "./web-ingress-test-harness.js";
const rpc = "platformclaw.spaces.";
describe("Web Space boundaries", () => {
  it("isolates Space listing, page tree, role changes and private sessions", async () => {
    const f = await fixture();
    expect(f.store.spaces.list(f.bob.user.id)).toEqual([]);
    await expect(
      f.proxy.request(f.bob.token, rpc + "get", { spaceId: f.space.id }),
    ).rejects.toThrow("unavailable");
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    expect(f.store.spaces.list(f.bob.user.id)[0]?.role).toBe("viewer");
    await expect(
      f.proxy.request(f.bob.token, rpc + "chat.send", {
        spaceId: f.space.id,
        pageId: f.page.id,
        message: "run",
        requestId: "q1",
      }),
    ).rejects.toThrow("conversation tab");
    await expect(
      f.proxy.request(f.bob.token, rpc + "page.save", {
        spaceId: f.space.id,
        pageId: f.page.id,
        title: "changed",
        body: "",
        expectedRevision: 1,
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      f.proxy.request(f.bob.token, rpc + "member.set", {
        spaceId: f.space.id,
        userId: f.carol.user.id,
        role: "owner",
        expectedRevision: 2,
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      f.proxy.request(f.bob.token, "chat.history", {
        sessionKey: `agent:${f.space.agentId}:space:${f.page.id}`,
      }),
    ).rejects.toThrow("denied");
    await expect(
      f.proxy.request(f.alice.token, rpc + "chat.send", {
        spaceId: f.space.id,
        pageId: f.page.id,
        message: "hello",
        requestId: "q1",
        agentId: f.alice.binding.agentId,
      }),
    ).rejects.toThrow("parameter");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("rechecks membership after async history and provisioning, and filters events", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    let release!: (value: unknown) => void;
    f.request.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.service.history(f.bob.user.id, f.space.id, f.page.id, async () => {});
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, null, 2);
    release({
      messages: [{ role: "user", content: "private after revoke", __openclaw: { id: "m1" } }],
    });
    await expect(pending).rejects.toThrow("unavailable");
    expect(
      f.service.event(f.bob.user.id, {
        event: "chat",
        payload: {
          sessionKey: `agent:${f.space.agentId}:space:${f.page.id}`,
          message: { content: "secret" },
        },
      }),
    ).toBeNull();
    expect(
      f.service.event(f.alice.user.id, {
        event: "chat",
        payload: {
          sessionKey: `agent:${f.space.agentId}:space:${f.page.id}`,
          message: { content: "secret" },
        },
      }),
    ).toEqual({
      event: "platformclaw.space.changed",
      payload: { spaceId: f.space.id, pageId: f.page.id },
    });
  });
  it("rejects stale revisions, cross-Space parents and removal of the last owner", async () => {
    const f = await fixture();
    const other = f.store.spaces.create(f.alice.user.id, "DRAM", "dram");
    expect(() =>
      f.store.spaces.createPage(f.alice.user.id, other.id, {
        title: "bad",
        body: "",
        parentId: f.page.id,
        requestId: "bad",
      }),
    ).toThrow("unavailable");
    expect(() =>
      f.store.spaces.setMember(f.alice.user.id, f.space.id, f.alice.user.id, null, 1),
    ).toThrow("one active");
    f.store.spaces.savePage(f.alice.user.id, f.space.id, f.page.id, "new", "changed", 1);
    expect(() =>
      f.store.spaces.savePage(f.alice.user.id, f.space.id, f.page.id, "overwrite", "bad", 1),
    ).toThrow("changed");
    expect(f.store.spaces.create(f.alice.user.id, "PMU", "create-pmu").id).toBe(f.space.id);
    expect(() => f.store.spaces.create(f.alice.user.id, "Other", "create-pmu")).toThrow("changed");
  });
  it("permits newly invited readers to see existing history but never tools or forged authors", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    f.request.mockResolvedValueOnce({
      messages: [
        {
          role: "user",
          content: "old question",
          __openclaw: { id: "m1", senderName: "unverified" },
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "reply" },
            { type: "thinking", thinking: "secret" },
          ],
          __openclaw: { id: "m2" },
        },
        { role: "toolResult", content: "token", __openclaw: { id: "m3" } },
      ],
    });
    const result = await f.proxy.request<{
      messages: Array<{ text: string; authorName: string | null }>;
    }>(f.bob.token, rpc + "chat.history", { spaceId: f.space.id, pageId: f.page.id });
    expect(result.messages.map((message) => message.text)).toEqual(["old question", "reply"]);
    expect(result.messages[0]?.authorName).toBeNull();
  });
  it("personal-agent recall only queries authorized Space keys and rejects malicious search results", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    f.request.mockResolvedValueOnce({
      results: [
        { sessionKey: `agent:${f.alice.binding.agentId}:main`, snippet: "personal secret" },
        {
          sessionKey: `agent:${f.space.agentId}:space:${f.page.id}`,
          snippet: "earlier PMU question",
          messageId: "m1",
        },
      ],
    });
    const result = await f.service.agentRead({
      agentId: f.bob.binding.agentId,
      operation: "search",
      query: "question",
    });
    expect(JSON.stringify(result)).toContain("earlier PMU question");
    expect(JSON.stringify(result)).not.toContain("personal secret");
    expect(f.request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({
        agentId: f.space.agentId,
        sessionKeys: [`agent:${f.space.agentId}:space:${f.page.id}`],
      }),
    );
    await expect(
      f.service.agentRead({
        agentId: f.space.agentId,
        operation: "get",
        spaceId: "other",
        pageId: f.page.id,
      }),
    ).rejects.toThrow("unavailable");
  });
  it.each(["viewer", null] as const)(
    "cancels an owner's admitted work after their own role changes to %s",
    async (role) => {
      const f = await fixture();
      f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
      const runId = `space:${f.page.id}:${f.alice.user.id}:self-removal`;
      f.store.spaces.beginRun(f.alice.user.id, f.space.id, f.page.id, runId, "queued question");
      await f.proxy.request(f.alice.token, rpc + (role ? "member.set" : "member.remove"), {
        spaceId: f.space.id,
        userId: f.alice.user.id,
        ...(role ? { role } : {}),
        expectedRevision: 2,
      });
      expect(f.request).toHaveBeenCalledWith("chat.abort", {
        agentId: f.space.agentId,
        sessionKey: `agent:${f.space.agentId}:space:${f.page.id}`,
        runId,
      });
      expect(() => f.store.spaces.assertRun(f.space.agentId, runId)).toThrow("unavailable");
    },
  );
  it("keeps private and other-Space corpus out of shared agent tools", async () => {
    const f = await fixture();
    const other = f.store.spaces.create(
      f.alice.user.id,
      "Cross-functional research",
      "arbitrary-space",
    );
    const runId = `space:${f.page.id}:${f.alice.user.id}:tool-run`;
    f.store.spaces.beginRun(f.alice.user.id, f.space.id, f.page.id, runId, "question");
    await expect(
      f.service.agentRead({
        agentId: f.space.agentId,
        runId,
        operation: "get",
        spaceId: other.id,
        pageId: f.page.id,
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      f.service.agentRead({
        agentId: f.space.agentId,
        operation: "context",
        sessionKey: `agent:${f.space.agentId}:space:${f.page.id}`,
      }),
    ).rejects.toThrow("unavailable");
    expect(
      await f.service.agentRead({
        agentId: f.space.agentId,
        runId,
        operation: "context",
        sessionKey: `agent:${f.space.agentId}:space:${f.page.id}`,
      }),
    ).toMatchObject({ spaceName: "PMU", page: { title: "SPMI timeout" } });
  });
  it("enforces three employees' roles and live revocation across real WebSocket ingress", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    const gateway = new FakeGateway();
    const server = new PlatformClawWebIngressServer({
      publicOrigin: "https://space-test.example",
      authService: f.auth,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: () => {},
      },
      gatewayProxy: f.proxy,
      gateway,
    });
    const clients: WebSocket[] = [];
    try {
      await server.listen({ host: "127.0.0.1", port: 0 });
      const port = (server.address() as AddressInfo).port;
      async function connect(token: string) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
          origin: "https://space-test.example",
          headers: { Cookie: `platformclaw_session=${token}` },
        });
        clients.push(ws);
        const frames: unknown[] = [];
        ws.on("message", (raw) =>
          frames.push(
            JSON.parse(
              Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : raw instanceof ArrayBuffer
                  ? Buffer.from(raw).toString("utf8")
                  : Buffer.concat(raw).toString("utf8"),
            ),
          ),
        );
        const framesNext = createFrameQueue(ws);
        const next = async (predicate: (frame: unknown) => boolean) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              framesNext(predicate),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(`Space transport timeout; received ${JSON.stringify(frames)}`),
                    ),
                  5000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        await new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        ws.send(
          JSON.stringify({
            type: "req",
            id: "connect",
            method: "connect",
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              role: "operator",
              scopes: ["operator.read", "operator.write"],
              client: {
                id: "openclaw-control-ui",
                version: "test",
                platform: "web",
                mode: "webchat",
              },
            },
          }),
        );
        const hello = await next(
          (frame) => isRecord(frame) && frame.type === "res" && frame.id === "connect",
        );
        expect(hello).toMatchObject({ ok: true });
        let sequence = 0;
        return {
          frames,
          next,
          async call(method: string, params: Record<string, unknown> = {}, native = false) {
            const id = `request-${++sequence}`;
            ws.send(
              JSON.stringify({ type: "req", id, method: native ? method : rpc + method, params }),
            );
            return await next(
              (frame) => isRecord(frame) && frame.type === "res" && frame.id === id,
            );
          },
        };
      }
      const alice = await connect(f.alice.token),
        bob = await connect(f.bob.token),
        carol = await connect(f.carol.token);
      expect(await carol.call("list")).toMatchObject({ ok: true, payload: [] });
      const created = await alice.call("conversation.create", {
        spaceId: f.space.id,
        pageId: f.page.id,
        title: "Alice native work",
        requestId: "transport-tab",
      });
      expect(created).toMatchObject({
        ok: true,
        payload: { ownerId: f.alice.user.id, agentId: f.alice.binding.agentId },
      });
      if (!isRecord(created) || !isRecord(created.payload)) {
        throw new Error("Missing conversation response");
      }
      const owned = created.payload;
      expect(await bob.call("get", { spaceId: f.space.id })).toMatchObject({
        ok: true,
        payload: { conversations: [] },
      });
      expect(
        await bob.call("conversation.history", { spaceId: f.space.id, conversationId: owned.id }),
      ).toMatchObject({ ok: false });
      expect(
        await bob.call(
          "chat.send",
          {
            sessionKey: owned.sessionKey,
            message: "use someone else's VM",
            idempotencyKey: "foreign",
          },
          true,
        ),
      ).toMatchObject({ ok: false });
      expect(
        await alice.call(
          "chat.send",
          {
            sessionKey: owned.sessionKey,
            message: "use my normal tools",
            idempotencyKey: "native",
          },
          true,
        ),
      ).toMatchObject({ ok: true });
      gateway.emit({
        type: "event",
        event: "session.tool",
        payload: {
          sessionKey: owned.sessionKey,
          agentId: f.alice.binding.agentId,
          data: { command: "owner-only tool trace" },
        },
      });
      await alice.next((frame) => isRecord(frame) && frame.event === "session.tool");
      // A subsequent response is the connection's ordering barrier for all earlier frames.
      await bob.call("get", { spaceId: f.space.id });
      expect(JSON.stringify(bob.frames)).not.toContain("owner-only tool trace");
      expect(JSON.stringify(carol.frames)).not.toContain("owner-only tool trace");
      expect(
        await bob.call("chat.send", {
          spaceId: f.space.id,
          pageId: f.page.id,
          message: "not permitted",
          requestId: "viewer-write",
        }),
      ).toMatchObject({ ok: false });
      expect(
        await bob.call("chat.history", { spaceId: f.space.id, pageId: f.page.id }),
      ).toMatchObject({ ok: true, payload: { messages: [] } });
      const key = `agent:${f.space.agentId}:space:${f.page.id}`;
      gateway.emit({
        type: "event",
        event: "chat",
        payload: {
          sessionKey: key,
          state: "delta",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "shared output" },
              { type: "thinking", thinking: "private reasoning" },
            ],
          },
          privateHost: "host-secret",
        },
      });
      await alice.next((frame) => isRecord(frame) && frame.event === "platformclaw.space.changed");
      await bob.next((frame) => isRecord(frame) && frame.event === "platformclaw.space.changed");
      expect(JSON.stringify(bob.frames)).not.toContain("private reasoning");
      expect(JSON.stringify(bob.frames)).not.toContain("host-secret");
      expect(
        await alice.call("member.remove", {
          spaceId: f.space.id,
          userId: f.bob.user.id,
          expectedRevision: 2,
        }),
      ).toMatchObject({ ok: true });
      gateway.emit({
        type: "event",
        event: "chat",
        payload: {
          sessionKey: key,
          state: "delta",
          message: { role: "assistant", content: "after revocation" },
        },
      });
      await alice.next(
        (frame) =>
          isRecord(frame) &&
          frame.event === "platformclaw.space.changed" &&
          isRecord(frame.payload) &&
          frame.payload.text === "after revocation",
      );
      expect(await bob.call("get", { spaceId: f.space.id })).toMatchObject({ ok: false });
      expect(JSON.stringify(bob.frames)).not.toContain("after revocation");
      expect(JSON.stringify(carol.frames)).not.toContain(f.space.id);
      expect(JSON.stringify(carol.frames)).not.toContain("shared output");
    } finally {
      for (const client of clients) {
        client.terminate();
      }
      await server.close();
    }
  });
  it("opens and searches new issue notes before a native conversation exists", async () => {
    const f = await fixture();
    const space = f.store.spaces.create(f.alice.user.id, "New project", "empty-space");
    const page = f.store.spaces.createPage(f.alice.user.id, space.id, {
      title: "Bringup checklist",
      body: "timing requirement",
      requestId: "first-notes",
    });
    expect(await f.service.history(f.alice.user.id, space.id, page.id, async () => {})).toEqual({
      messages: [],
    });
    expect(
      await f.service.search(f.alice.user.id, "timing", space.id, async () => {}),
    ).toMatchObject({ results: [{ pageId: page.id, snippet: "timing requirement" }] });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("finds notes-only pages from a shared run and shows the matching text", async () => {
    const f = await fixture();
    const body = `${"earlier context ".repeat(700)}needle evidence after the first window`;
    const page = f.store.spaces.createPage(f.alice.user.id, f.space.id, {
      title: "Notes without a conversation",
      body,
      requestId: "notes-only",
    });
    const result = await f.service.agentRead({
      agentId: f.space.agentId,
      runId: "fixture-history",
      operation: "search",
      query: "needle evidence",
    });
    expect(result).toMatchObject({
      results: [
        {
          pageId: page.id,
          snippet: expect.stringContaining("needle evidence"),
          bodyOffset: expect.any(Number),
          pageRevision: page.revision,
        },
      ],
    });
    expect(f.request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ sessionKeys: [`agent:${f.space.agentId}:space:${f.page.id}`] }),
    );
    const personal = await f.service.search(
      f.alice.user.id,
      "needle evidence",
      f.space.id,
      async () => {},
    );
    expect(personal).toMatchObject({
      results: [{ snippet: expect.stringContaining("needle evidence") }],
    });
  });
  it.each(["personal", "shared"] as const)(
    "reads every page window and rejects stale continuation for %s agents",
    async (kind) => {
      const f = await fixture();
      const body = "abcdefgh".repeat(4000);
      const page = f.store.spaces.createPage(f.alice.user.id, f.space.id, {
        title: "Long issue",
        body,
        requestId: "long-notes",
      });
      const params = {
        agentId: kind === "shared" ? f.space.agentId : f.alice.binding.agentId,
        runId: "fixture-history",
        operation: "get",
        spaceId: f.space.id,
        pageId: page.id,
      };
      const chunks: string[] = [];
      let bodyOffset: number | null = 0;
      for (let index = 0; index < 16 && bodyOffset !== null; index++) {
        const result = await f.service.agentRead({
          ...params,
          bodyOffset,
          pageRevision: page.revision,
        });
        expect(result).toHaveProperty("page");
        const window = (
          result as { page: { body: string; bodyOffset: number; nextBodyOffset: number | null } }
        ).page;
        expect(window.body.length).toBeLessThanOrEqual(8000);
        expect(window.bodyOffset).toBe(bodyOffset);
        chunks.push(window.body);
        bodyOffset = window.nextBodyOffset;
      }
      expect(bodyOffset).toBeNull();
      expect(chunks.join("")).toBe(body);
      expect(f.request).not.toHaveBeenCalled();
      await expect(f.service.agentRead({ ...params, bodyOffset: 8000 })).rejects.toThrow(
        "revision",
      );
      f.store.spaces.savePage(
        f.alice.user.id,
        f.space.id,
        page.id,
        page.title,
        "replacement",
        page.revision,
      );
      await expect(
        f.service.agentRead({ ...params, bodyOffset: 8000, pageRevision: page.revision }),
      ).rejects.toThrow("changed");
    },
  );
  it("keeps individually queued requests authorized and cancellable until native settlement", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const runId = `space:${f.page.id}:${f.bob.user.id}:queued`;
    f.store.spaces.beginRun(f.bob.user.id, f.space.id, f.page.id, runId, "queued");
    const payload = {
      sessionKey: `agent:${f.space.agentId}:space:${f.page.id}`,
      state: "final",
      runId,
    };
    f.service.observe({ event: "chat", payload: { ...payload, queuePhase: "deferred" } });
    expect(() => f.store.spaces.assertRun(f.space.agentId, runId)).not.toThrow();
    await expect(
      f.service.agentRead({
        agentId: f.space.agentId,
        runId,
        operation: "context",
        sessionKey: payload.sessionKey,
      }),
    ).resolves.toMatchObject({ page: { id: f.page.id } });
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, null, 2);
    await f.service.cancelRevoked(f.space, f.bob.user.id);
    expect(f.request).toHaveBeenCalledWith("chat.abort", {
      agentId: f.space.agentId,
      sessionKey: payload.sessionKey,
      runId,
    });
    expect(() => f.store.spaces.assertRun(f.space.agentId, runId)).toThrow("unavailable");
    f.service.observe({ event: "chat", payload: { ...payload, queuePhase: "settled" } });
    expect(() => f.store.spaces.assertRun(f.space.agentId, runId)).toThrow("unavailable");
  });

  it("retires acknowledged revocations so historical runs cannot hide a new cancellation", async () => {
    const f = await fixture();
    f.store.spaces.finishRun("fixture-history");
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    for (let i = 0; i < 200; i++) {
      f.store.spaces.beginRun(f.bob.user.id, f.space.id, f.page.id, `old-${i}`, "question");
    }
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, null, 2);
    await f.service.cancelRevoked(f.space, f.bob.user.id);
    expect(f.store.spaces.revokedRuns(f.space.id, f.bob.user.id)).toEqual([]);
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 3);
    expect(f.store.spaces.beginRun(f.bob.user.id, f.space.id, f.page.id, "old-0", "question")).toBe(
      true,
    );
    expect(() => f.store.spaces.assertRun(f.space.agentId, "old-0")).toThrow("unavailable");
    f.store.spaces.beginRun(f.bob.user.id, f.space.id, f.page.id, "new-201", "new question");
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, null, 4);
    f.request.mockClear();
    f.request.mockResolvedValue({ ok: true, aborted: false });
    await f.service.cancelRevoked(f.space, f.bob.user.id);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "chat.abort",
      expect.objectContaining({ runId: "new-201" }),
    );
    expect(f.store.spaces.revokedRuns(f.space.id, f.bob.user.id)).toEqual([]);
  });

  it("pages past failed and uncertain cancellations without reopening their authorization", async () => {
    const f = await fixture();
    f.store.spaces.finishRun("fixture-history");
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    for (let i = 0; i < 200; i++) {
      f.store.spaces.beginRun(f.bob.user.id, f.space.id, f.page.id, `old-${i}`, "question");
    }
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, null, 2);
    f.request.mockImplementation(async (_method, raw) => {
      const runId = (raw as { runId: string }).runId;
      if (runId === "old-0") {
        return { status: "unknown" };
      }
      if (runId.startsWith("old-")) {
        throw new Error("native owner unavailable");
      }
      return { ok: true, aborted: true };
    });
    await expect(f.service.cancelRevoked(f.space, f.bob.user.id)).rejects.toThrow(
      "could not be stopped",
    );
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 3);
    f.store.spaces.beginRun(f.bob.user.id, f.space.id, f.page.id, "zz-new-201", "new question");
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, null, 4);
    f.request.mockClear();
    await expect(f.service.cancelRevoked(f.space, f.bob.user.id)).rejects.toThrow(
      "could not be stopped",
    );
    expect(f.request).toHaveBeenCalledTimes(201);
    expect(f.request).toHaveBeenCalledWith(
      "chat.abort",
      expect.objectContaining({ runId: "zz-new-201" }),
    );
    expect(f.store.spaces.revokedRuns(f.space.id, f.bob.user.id)).toHaveLength(200);
    expect(() => f.store.spaces.assertRun(f.space.agentId, "old-0")).toThrow("unavailable");
    f.request.mockResolvedValue({ ok: true, aborted: true });
    await f.service.cancelRevoked(f.space, f.bob.user.id);
    expect(f.store.spaces.revokedRuns(f.space.id, f.bob.user.id)).toEqual([]);
  });

  it("applies the active quota to failed retries without charging replays twice", async () => {
    const f = await fixture();
    f.store.spaces.finishRun("fixture-history");
    f.store.spaces.beginRun(f.alice.user.id, f.space.id, f.page.id, "retry", "question");
    f.store.spaces.failRun("retry");
    for (let i = 0; i < 200; i++) {
      f.store.spaces.beginRun(f.alice.user.id, f.space.id, f.page.id, `pending-${i}`, "question");
    }
    expect(() =>
      f.store.spaces.beginRun(f.alice.user.id, f.space.id, f.page.id, "retry", "question"),
    ).toThrow("too many pending");
    expect(
      f.store.spaces.beginRun(f.alice.user.id, f.space.id, f.page.id, "pending-0", "question"),
    ).toBe(false);
    expect(
      f.store.spaces.beginRun(
        f.alice.user.id,
        f.space.id,
        f.page.id,
        "fixture-history",
        "existing shared question",
      ),
    ).toBe(true);
    f.store.spaces.finishRun("pending-0");
    expect(
      f.store.spaces.beginRun(f.alice.user.id, f.space.id, f.page.id, "retry", "question"),
    ).toBe(false);
    expect(() => f.store.spaces.assertRun(f.space.agentId, "retry")).not.toThrow();
  });

  it("preserves exact message anchors in shared-agent source links", async () => {
    const f = await fixture();
    const runId = `space:${f.page.id}:${f.alice.user.id}:anchor`;
    f.store.spaces.beginRun(f.alice.user.id, f.space.id, f.page.id, runId, "question");
    f.request.mockResolvedValueOnce({
      results: [
        {
          sessionKey: `agent:${f.space.agentId}:space:${f.page.id}`,
          messageId: "old/message",
          snippet: "earlier evidence",
        },
      ],
    });
    const result = await f.service.agentRead({
      agentId: f.space.agentId,
      runId,
      operation: "search",
      query: "evidence",
    });
    expect(JSON.stringify(result)).toContain("&message=old%2Fmessage");
  });
});
