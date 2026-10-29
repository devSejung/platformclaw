import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserComposerHandler } from "./browser-composer-http.js";
import { setupBrowserGatewayProxyTest } from "./browser-gateway-proxy.test-harness.js";
import { createSpaceTestConversation } from "./space-conversation.test-helpers.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) {
    await close();
  }
});

async function setup(
  input?: Pick<
    Awaited<ReturnType<typeof setupBrowserGatewayProxyTest>>,
    "proxy" | "request" | "binding" | "user" | "token"
  >,
) {
  const fixture = input ?? (await setupBrowserGatewayProxyTest());
  fixture.request.mockResolvedValue({
    messages: [
      { role: "system", content: "private instructions" },
      { role: "user", content: "질문" },
      { role: "toolResult", content: "private tool output" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "reasoning" },
          { type: "text", text: "답변" },
        ],
      },
    ],
  });
  const call = vi.fn(async (_method: string, params: unknown) => {
    const request = params as { action: string };
    return request.action === "preferences"
      ? { available: true, enabled: true, timeoutMs: 30_000 }
      : { text: "다음 질문" };
  });
  const handler = createBrowserComposerHandler({
    gatewayProxy: fixture.proxy,
    adminRpc: { call: call as never },
    isOriginAllowed: (req) => req.headers.origin === "http://browser.test",
  });
  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing HTTP address");
  }
  const post = (body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${address.port}/platformclaw/api/composer-predictions`, {
      method: "POST",
      headers: {
        origin: "http://browser.test",
        cookie: `platformclaw_session=${fixture.token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal,
    });
  return { ...fixture, call, post };
}

describe("authenticated Web-only prediction ingress", () => {
  it("loads authorized history, excludes tools/reasoning, and pins the user", async () => {
    const { post, call, binding, user } = await setup();
    const response = await post({ action: "predict", sessionKey: `agent:${binding.agentId}:main` });
    expect(await response.json()).toEqual({ text: "다음 질문" });
    expect(call).toHaveBeenCalledWith(
      "platformclaw.composer",
      {
        action: "predict",
        userId: user.id,
        messages: [
          { role: "user", content: "질문" },
          { role: "assistant", content: "답변" },
        ],
      },
      expect.any(AbortSignal),
      { timeoutMs: 30_000 },
    );
  });
  it("blocks non-browser callers, foreign sessions, and client-supplied identity/context", async () => {
    const { post, call } = await setup();
    expect(
      (await post({ action: "predict", sessionKey: "agent:other:main" }, { cookie: "" })).status,
    ).toBe(401);
    expect((await post({ action: "predict" }, { origin: "http://messenger.test" })).status).toBe(
      403,
    );
    expect(
      (
        await post({
          action: "predict",
          sessionKey: "agent:other:main",
          userId: "someone",
          messages: [],
        })
      ).status,
    ).toBe(400);
    await post({ action: "predict", sessionKey: "agent:other:main" });
    expect(
      call.mock.calls.some(([, body]) => (body as { action: string }).action === "predict"),
    ).toBe(false);
  });
  it("does no history or inference work when the feature is off", async () => {
    const { post, call, request, binding } = await setup();
    call.mockResolvedValueOnce({ available: false, enabled: false } as never);
    expect(
      await (await post({ action: "predict", sessionKey: `agent:${binding.agentId}:main` })).json(),
    ).toEqual({ text: null });
    expect(request).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("keeps Space predictions private and rechecks revoked membership after inference", async () => {
    const f = await createSpaceTestFixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const conversation = await createSpaceTestConversation(f);
    if (f.alice.binding.kind !== "personal") {
      throw new Error("personal binding required");
    }
    const { post, call } = await setup({
      proxy: f.proxy,
      request: f.request,
      binding: f.alice.binding,
      user: f.alice.user,
      token: f.alice.token,
    });
    const body = { action: "predict", sessionKey: conversation.sessionKey };
    expect(await (await post(body)).json()).toEqual({ text: "다음 질문" });
    call.mockClear();
    await post(body, { cookie: "platformclaw_session=bob" });
    expect(
      call.mock.calls.some(([, value]) => (value as { action: string }).action === "predict"),
    ).toBe(false);
    call.mockImplementation(async (_method, value) => {
      if ((value as { action: string }).action === "predict") {
        f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
        return { text: "must not leak" };
      }
      return { available: true, enabled: true, timeoutMs: 30_000 };
    });
    expect(await (await post(body)).json()).toEqual({ text: null });
  });
  it("caps the whole request at the configured deadline while Gateway history is waiting", async () => {
    const { post, request, call, binding } = await setup();
    call.mockResolvedValueOnce({ available: true, enabled: true, timeoutMs: 1000 } as never);
    let release!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    expect(
      await (await post({ action: "predict", sessionKey: `agent:${binding.agentId}:main` })).json(),
    ).toEqual({ text: null });
    release({ messages: [] });
    expect(
      call.mock.calls.some(([, value]) => (value as { action: string }).action === "predict"),
    ).toBe(false);
  });
  it("allows authorized history to finish after the old ten-second deadline", async () => {
    const { post, request, call, binding } = await setup();
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                messages: [
                  { role: "user", content: "질문" },
                  { role: "assistant", content: "답변" },
                ],
              }),
            10_100,
          );
        }),
    );
    expect(
      await (await post({ action: "predict", sessionKey: `agent:${binding.agentId}:main` })).json(),
    ).toEqual({
      text: "다음 질문",
    });
    expect(call).toHaveBeenCalledWith(
      "platformclaw.composer",
      expect.objectContaining({ action: "predict" }),
      expect.any(AbortSignal),
      { timeoutMs: 30_000 },
    );
  }, 15_000);
  it("aborts model work when the browser cancels its prediction request", async () => {
    const { post, call, binding } = await setup();
    let inferenceSignal: AbortSignal | undefined;
    call.mockImplementation(async (_method, value, ...args: unknown[]) => {
      if ((value as { action: string }).action === "preferences") {
        return { available: true, enabled: true, timeoutMs: 30_000 };
      }
      const signal = args[0] as AbortSignal;
      inferenceSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    const controller = new AbortController();
    const pending = post(
      { action: "predict", sessionKey: `agent:${binding.agentId}:main` },
      {},
      controller.signal,
    );
    await vi.waitFor(() => expect(inferenceSignal).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(inferenceSignal?.aborted).toBe(true));
  });
});
