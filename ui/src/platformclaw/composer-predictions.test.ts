import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "../pages/chat/chat-history.ts";
import { requestChatSend } from "../pages/chat/chat-send-request.ts";
import {
  ComposerPredictionController,
  updateComposerPreferences,
  recordWebComposerDispatch,
  recordWebComposerRun,
  webComposerRunSession,
} from "./composer-predictions.ts";

describe("Web composer predictions", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let prediction: ComposerPredictionController;
  let timeoutMs: number;
  const source = {
    client: {},
    sessionKey: "agent:personal:main",
    completedRunId: "run-1",
    idle: true,
    eligible: true,
  };
  const requestBody = (options?: RequestInit) => {
    if (typeof options?.body !== "string") {
      throw new Error("Expected a JSON string request body");
    }
    return JSON.parse(options.body) as { action: string; enabled?: boolean };
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    timeoutMs = 30_000;
    fetchMock.mockImplementation(async (_url, options) => {
      const body = requestBody(options);
      return Response.json(
        body.action === "preferences"
          ? { available: true, enabled: body.enabled ?? true, timeoutMs }
          : { text: "구체적인 실행 방법을 알려줘" },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    prediction = new ComposerPredictionController(vi.fn());
    await updateComposerPreferences(true);
  });
  afterEach(() => {
    prediction.dispose();
    fetchMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const predictCalls = () =>
    fetchMock.mock.calls.filter(([, options]) => requestBody(options).action === "predict");
  it("waits one second, predicts once per completion, and only takes explicit text", async () => {
    prediction.sync(source);
    await vi.advanceTimersByTimeAsync(999);
    expect(predictCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(prediction.text).toBe("구체적인 실행 방법을 알려줘");
    expect(prediction.take()).toBe("구체적인 실행 방법을 알려줘");
    expect(prediction.text).toBeNull();
    prediction.sync(source);
    await vi.advanceTimersByTimeAsync(2000);
    expect(predictCalls()).toHaveLength(1);
  });
  it.each(["typing", "session", "client", "run", "off"])(
    "discards a late response after %s",
    async (reason) => {
      let resolve!: (response: Response) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      prediction.sync(source);
      await vi.advanceTimersByTimeAsync(1000);
      const signal = predictCalls()[0]?.[1]?.signal;
      if (reason === "typing") {
        prediction.sync({ ...source, eligible: false });
      }
      if (reason === "session") {
        prediction.sync({ ...source, sessionKey: "agent:personal:other", completedRunId: null });
      }
      if (reason === "client") {
        prediction.sync({ ...source, client: {}, completedRunId: null });
      }
      if (reason === "run") {
        prediction.sync({ ...source, idle: false, completedRunId: null });
      }
      if (reason === "off") {
        await updateComposerPreferences(false);
      }
      expect(signal?.aborted).toBe(true);
      resolve(Response.json({ text: "stale" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(prediction.text).toBeNull();
    },
  );
  it("makes no prediction request while disabled", async () => {
    await updateComposerPreferences(false);
    prediction.sync(source);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(predictCalls()).toHaveLength(0);
  });
  it("retains a completed anchor until the composer becomes idle", async () => {
    prediction.sync({ ...source, idle: false });
    prediction.sync(source);
    await vi.advanceTimersByTimeAsync(1000);
    expect(prediction.text).not.toBeNull();
  });
  it.each([
    { responseAfterMs: 11_000, aborted: false, text: "slow prediction" },
    { responseAfterMs: 20_001, aborted: true, text: null },
  ])("honors the server timeout for a response after $responseAfterMs ms", async (scenario) => {
    timeoutMs = 20_000;
    await updateComposerPreferences();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), delay);
      return controller.signal;
    });
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    prediction.sync(source);
    await vi.advanceTimersByTimeAsync(1000);
    const signal = predictCalls()[0]?.[1]?.signal;
    expect(signal).toBeDefined();
    await vi.advanceTimersByTimeAsync(scenario.responseAfterMs);
    expect(signal?.aborted).toBe(scenario.aborted);
    resolve(Response.json({ text: "slow prediction" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(prediction.text).toBe(scenario.text);
  });
  it("rejects out-of-contract timeout metadata without making a prediction", async () => {
    timeoutMs = 300_001;
    await updateComposerPreferences();
    prediction.sync(source);
    await vi.advanceTimersByTimeAsync(2000);
    expect(predictCalls()).toHaveLength(0);
  });
  it.each(["started", "error", "timeout"] as const)(
    "cancels at browser dispatch before a %s ACK and ignores the old completion afterward",
    async (status) => {
      let resolvePrediction!: (response: Response) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolvePrediction = done;
          }),
      );
      let resolveAck!: (ack: unknown) => void;
      const ack = new Promise((resolve) => {
        resolveAck = resolve;
      });
      const request = vi.fn(
        (_method: string, _params: unknown, options?: { onSent?: () => void }) => {
          expect(predictCalls()[0]?.[1]?.signal?.aborted).toBe(false);
          options?.onSent?.();
          return ack;
        },
      );
      const client = { request };
      const currentSource = { ...source, client };
      prediction.sync(currentSource);
      await vi.advanceTimersByTimeAsync(1000);
      const signal = predictCalls()[0]?.[1]?.signal;
      const state = {
        client: client as unknown as ChatState["client"],
        sessionKey: source.sessionKey,
      } as ChatState;
      const sending = requestChatSend(state, { message: "new reply", runId: "new-run" });
      expect(request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({ message: "new reply" }),
        { onSent: expect.any(Function) },
      );
      expect(signal?.aborted).toBe(true);
      expect(webComposerRunSession(client, "new-run")).toBe(source.sessionKey);
      resolvePrediction(Response.json({ text: "stale" }));
      await vi.advanceTimersByTimeAsync(0);
      prediction.sync(currentSource);
      await vi.advanceTimersByTimeAsync(1000);
      expect(prediction.text).toBeNull();
      expect(predictCalls()).toHaveLength(1);
      resolveAck({ runId: "server-run", status });
      await expect(sending).resolves.toMatchObject({ runId: "server-run" });
      expect(webComposerRunSession(client, "server-run")).toBe(
        status === "started" ? source.sessionKey : undefined,
      );
    },
  );
  it("preserves the pending prediction when the socket rejects before sending", async () => {
    let resolvePrediction!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolvePrediction = done;
        }),
    );
    const client = { request: vi.fn().mockRejectedValue(new Error("socket send failed")) };
    prediction.sync({ ...source, client });
    await vi.advanceTimersByTimeAsync(1000);
    const signal = predictCalls()[0]?.[1]?.signal;
    const state = {
      client: client as unknown as ChatState["client"],
      sessionKey: source.sessionKey,
    } as ChatState;
    await expect(
      requestChatSend(state, { message: "unsent reply", runId: "unsent-run" }),
    ).rejects.toThrow("socket send failed");
    expect(signal?.aborted).toBe(false);
    expect(webComposerRunSession(client, "unsent-run")).toBeUndefined();
    resolvePrediction(Response.json({ text: "still current" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(prediction.text).toBe("still current");
  });
  it("adopts a delayed ACK ID without cancelling the completed reply's prediction", async () => {
    let resolveAck!: (ack: unknown) => void;
    const ack = new Promise((resolve) => {
      resolveAck = resolve;
    });
    const client = {
      request: vi.fn((_method: string, _params: unknown, options?: { onSent?: () => void }) => {
        options?.onSent?.();
        return ack;
      }),
    };
    prediction.sync({ ...source, client });
    const state = {
      client: client as unknown as ChatState["client"],
      sessionKey: source.sessionKey,
    } as ChatState;
    const sending = requestChatSend(state, { message: "new reply", runId: "new-run" });
    prediction.sync({ ...source, client, completedRunId: "server-run" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(prediction.text).toBe("구체적인 실행 방법을 알려줘");
    resolveAck({ runId: "server-run", status: "ok" });
    await sending;
    expect(webComposerRunSession(client, "server-run")).toBe(source.sessionKey);
    expect(prediction.text).toBe("구체적인 실행 방법을 알려줘");
  });
  it("limits dispatch cancellation to the same client and session and retires a pending timer", async () => {
    prediction.sync(source);
    recordWebComposerDispatch({}, source.sessionKey, "other-client-run");
    recordWebComposerDispatch(source.client, "agent:personal:other", "other-session-run");
    await vi.advanceTimersByTimeAsync(1000);
    expect(prediction.text).not.toBeNull();
    prediction.sync({ ...source, completedRunId: "next-completion" });
    recordWebComposerDispatch(source.client, source.sessionKey.toUpperCase(), "next-dispatch");
    prediction.sync({ ...source, completedRunId: "next-completion" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(prediction.text).toBeNull();
    expect(predictCalls()).toHaveLength(1);
  });
  it("retires a completion dispatched before its first idle render", async () => {
    prediction.sync({ ...source, idle: false });
    recordWebComposerDispatch(source.client, source.sessionKey, "new-dispatch");
    prediction.sync(source);
    await vi.advanceTimersByTimeAsync(1000);
    expect(prediction.text).toBeNull();
    expect(predictCalls()).toHaveLength(0);
  });
  it("unsubscribes from browser dispatch when disposed", async () => {
    prediction.dispose();
    const requestUpdate = vi.fn();
    prediction = new ComposerPredictionController(requestUpdate);
    await vi.advanceTimersByTimeAsync(0);
    prediction.sync(source);
    prediction.dispose();
    requestUpdate.mockClear();
    recordWebComposerDispatch(source.client, source.sessionKey, "after-dispose");
    await vi.advanceTimersByTimeAsync(1000);
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(predictCalls()).toHaveLength(0);
  });
  it("requires a browser dispatch fact and isolates its client and run identity", () => {
    const client = {};
    expect(webComposerRunSession(client, "cron-run")).toBeUndefined();
    recordWebComposerRun(client, source.sessionKey, "web-run");
    expect(webComposerRunSession(client, "web-run")).toBe(source.sessionKey);
    expect(webComposerRunSession({}, "web-run")).toBeUndefined();
    expect(webComposerRunSession(client, "knox-run")).toBeUndefined();
    for (let index = 0; index < 64; index++) {
      recordWebComposerRun(client, source.sessionKey, `web-${index}`);
    }
    expect(webComposerRunSession(client, "web-run")).toBeUndefined();
  });
});
