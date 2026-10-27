import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposerPredictions } from "./composer-predictions.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetch,
  isPrivateOrLoopbackHost: (address: string) => address === "10.1.2.3",
}));

function setup() {
  const values = new Map<string, boolean>();
  const hooks = new Map<string, (event: { callId: string }) => void>();
  const config = {
    plugins: { entries: { "admin-http-rpc": { config: { composerPredictionsEnabled: true } } } },
    models: {
      providers: {
        codemate: {
          baseUrl: "http://company.internal/v1",
          api: "openai-completions",
          models: [{ id: "codellm-fast" }],
        },
      },
    },
  };
  const api = {
    runtime: {
      config: { current: () => config },
      state: {
        openKeyedStore: () => ({
          lookup: async (key: string) => values.get(key),
          register: async (key: string, enabled: boolean) => {
            values.set(key, enabled);
          },
        }),
      },
    },
    on: (name: string, hook: (event: { callId: string }) => void) => hooks.set(name, hook),
  } as unknown as OpenClawPluginApi;
  mocks.lookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
  mocks.fetch.mockImplementation(async () => ({
    response: Response.json({ choices: [{ message: { content: "다음 단계는 무엇인가요?" } }] }),
    release: async () => {},
  }));
  const call = createComposerPredictions(api);
  const params = {
    action: "predict",
    userId: "user-1",
    messages: [
      { role: "user", content: "계획" },
      { role: "assistant", content: "답변" },
    ],
  };
  const predict = (signal = new AbortController().signal) => call(params, signal);
  return { call, predict, hooks, config, values, params };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("Fast-only isolated inference", () => {
  it("defaults OFF, isolates account preferences, and never follows conversation models", async () => {
    const { call, predict, params } = setup();
    expect(await predict()).toEqual({ text: null });
    const signal = new AbortController().signal;
    await call({ action: "preferences", userId: "user-1", enabled: true }, signal);
    expect(await call({ ...params, userId: "user-2" }, signal)).toEqual({ text: null });
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?" });
    const request = mocks.fetch.mock.calls[0]?.[0];
    const body = JSON.parse(request.init.body);
    expect(body).toMatchObject({ model: "codellm-fast", max_tokens: 64, stream: false });
    expect(body.tools).toBeUndefined();
    expect(request.capture).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("skips concurrent predictions and preempts them for ordinary chat", async () => {
    const { predict, hooks, values } = setup();
    values.set("user-1", true);
    let abortSignal: AbortSignal | undefined;
    mocks.fetch.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          abortSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const pending = predict();
    await vi.waitFor(() => expect(abortSignal).toBeDefined());
    expect(await predict()).toEqual({ text: null });
    hooks.get("model_call_started")?.({ callId: "normal-chat" });
    expect(abortSignal?.aborted).toBe(true);
    expect(await pending).toEqual({ text: null });
    expect(await predict()).toEqual({ text: null });
    hooks.get("model_call_ended")?.({ callId: "normal-chat" });
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?" });
  });
  it("rejects public destinations and does not retry or fall back on failure", async () => {
    const { predict, values } = setup();
    values.set("user-1", true);
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    expect(await predict()).toEqual({ text: null });
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.fetch.mockRejectedValueOnce(new Error("private failure"));
    expect(await predict()).toEqual({ text: null });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("forwards cancellation without leaking the response", async () => {
    const { predict, values } = setup();
    values.set("user-1", true);
    const controller = new AbortController();
    controller.abort();
    expect(await predict(controller.signal)).toEqual({ text: null });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
