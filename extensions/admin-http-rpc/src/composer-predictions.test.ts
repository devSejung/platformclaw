import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComposerPredictions } from "./composer-predictions.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetch,
  isPrivateOrLoopbackHost: (address: string) => address === "10.1.2.3",
}));

function setup(providerId = "codemate", modelId = "codellm-fast", apiType = "openai-completions") {
  const values = new Map<string, boolean>();
  const pluginConfig: {
    composerPredictionsEnabled?: boolean;
    composerPredictionsTimeoutMs?: number;
  } = { composerPredictionsEnabled: true };
  const config = {
    plugins: { entries: { "admin-http-rpc": { config: pluginConfig } } },
    models: {
      providers: {
        [providerId]: {
          baseUrl: "http://company.internal/v1",
          api: apiType,
          models: [{ id: modelId }],
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
  } as unknown as OpenClawPluginApi;
  mocks.lookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
  mocks.fetch.mockImplementation(async () => ({
    response: Response.json({ choices: [{ message: { content: "다음 단계는 무엇인가요?" } }] }),
    release: async () => {},
  }));
  const composer = createComposerPredictions(api);
  const call = composer.handleRequest;
  const params = {
    action: "predict",
    userId: "user-1",
    messages: [
      { role: "user", content: "계획" },
      { role: "assistant", content: "답변" },
    ],
  };
  const predict = (signal = new AbortController().signal) => call(params, signal);
  return { call, predict, composer, values, params, pluginConfig };
}

function useDeadlineClock() {
  vi.useFakeTimers();
  // Node's native AbortSignal.timeout bypasses the global timers replaced by Vitest.
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const deadline = new AbortController();
    setTimeout(
      () => deadline.abort(new DOMException("Prediction timed out", "TimeoutError")),
      milliseconds,
    );
    return deadline.signal;
  });
}
beforeEach(() => {
  vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Explicit isolated prediction inference", () => {
  it("defaults OFF, isolates account preferences, and never follows conversation models", async () => {
    const { call, predict, params } = setup();
    expect(await predict()).toEqual({ text: null });
    const signal = new AbortController().signal;
    expect(await call({ action: "preferences", userId: "user-1" }, signal)).toEqual({
      available: true,
      enabled: false,
      timeoutMs: 30_000,
    });
    expect(await call({ action: "preferences", userId: "user-1", enabled: true }, signal)).toEqual({
      available: true,
      enabled: true,
      timeoutMs: 30_000,
    });
    expect(await call({ ...params, userId: "user-2" }, signal)).toEqual({ text: null });
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?" });
    const request = mocks.fetch.mock.calls[0]?.[0];
    const body = JSON.parse(request.init.body);
    expect(body).toMatchObject({ model: "codellm-fast", max_tokens: 64, stream: false });
    expect(body.tools).toBeUndefined();
    expect(request.capture).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      name: "omitted server gate",
      server: undefined,
      account: true,
      available: false,
      enabled: true,
    },
    { name: "disabled server gate", server: false, account: true, available: false, enabled: true },
    {
      name: "missing account preference",
      server: true,
      account: undefined,
      available: true,
      enabled: false,
    },
    {
      name: "disabled account preference",
      server: true,
      account: false,
      available: true,
      enabled: false,
    },
  ])(
    "keeps $name and returns the configured timeout",
    async ({ server, account, available, enabled }) => {
      const { call, predict, values, pluginConfig } = setup();
      pluginConfig.composerPredictionsEnabled = server;
      pluginConfig.composerPredictionsTimeoutMs = 45_000;
      if (account !== undefined) {
        values.set("user-1", account);
      }
      expect(
        await call({ action: "preferences", userId: "user-1" }, new AbortController().signal),
      ).toEqual({
        available,
        enabled,
        timeoutMs: 45_000,
      });
      expect(await predict()).toEqual({ text: null });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
  it("allows a configured inference to finish beyond the former ten-second deadline", async () => {
    const timeout = useDeadlineClock();
    const { predict, values, pluginConfig } = setup();
    pluginConfig.composerPredictionsTimeoutMs = 45_000;
    values.set("user-1", true);
    let upstreamSignal: AbortSignal | undefined;
    mocks.fetch.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<{ response: Response; release: () => Promise<void> }>((resolve, reject) => {
          upstreamSignal = signal;
          const timer = setTimeout(() => {
            resolve({
              response: Response.json({
                choices: [{ message: { content: "다음 단계는 무엇인가요?" } }],
              }),
              release: async () => {},
            });
          }, 15_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    const pending = predict();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual({ text: "다음 단계는 무엇인가요?" });
    expect(upstreamSignal?.aborted).toBe(false);
    expect(timeout).toHaveBeenCalledWith(45_000);
  });
  it("aborts at the configured deadline and releases prediction admission", async () => {
    useDeadlineClock();
    const { predict, values, pluginConfig } = setup();
    pluginConfig.composerPredictionsTimeoutMs = 12_000;
    values.set("user-1", true);
    let upstreamSignal: AbortSignal | undefined;
    mocks.fetch.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          upstreamSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const pending = predict();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(upstreamSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(await pending).toEqual({ text: null });
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?" });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("releases an interrupted response stream and admits the next prediction", async () => {
    const { predict, values } = setup();
    values.set("user-1", true);
    const release = vi.fn(async () => {});
    let upstreamResponse: Response | undefined;
    mocks.fetch.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      upstreamResponse = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        }),
      );
      return { response: upstreamResponse, release };
    });
    const cancellation = new AbortController();
    const pending = predict(cancellation.signal);
    await vi.waitFor(() => expect(upstreamResponse?.body?.locked).toBe(true));
    cancellation.abort();
    expect(await pending).toEqual({ text: null });
    expect(release).toHaveBeenCalledTimes(1);
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?" });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("uses the configured provider/model and pins it until plugin recreation", async () => {
    vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", "  company-fast/org/followup-v2  ");
    const { predict, values } = setup("company-fast", "org/followup-v2");
    values.set("user-1", true);
    vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", "codemate/codellm-fast");
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?" });
    const request = mocks.fetch.mock.calls[0]?.[0];
    expect(JSON.parse(request.init.body).model).toBe("org/followup-v2");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["", "   "])("keeps the default for an empty model environment (%j)", async (value) => {
    vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", value);
    const { predict, values } = setup();
    values.set("user-1", true);
    await predict();
    expect(JSON.parse(mocks.fetch.mock.calls[0]?.[0].init.body).model).toBe("codellm-fast");
  });
  it.each(["codellm-fast", "/fast", "codemate/", "missing/fast", "codemate/missing"])(
    "skips an invalid or unavailable explicit selection (%s) without fallback",
    async (value) => {
      vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", value);
      const { predict, values } = setup();
      values.set("user-1", true);
      expect(await predict()).toEqual({ text: null });
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.lookup).not.toHaveBeenCalled();
    },
  );
  it("rejects an unsupported API on the selected provider", async () => {
    vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", "company-fast/followup-v2");
    const { predict, values } = setup("company-fast", "followup-v2", "anthropic-messages");
    values.set("user-1", true);
    expect(await predict()).toEqual({ text: null });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("skips concurrent predictions and preempts them for ordinary chat", async () => {
    const { predict, composer, values } = setup();
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
    composer.modelCallStarted("normal-chat");
    expect(abortSignal?.aborted).toBe(true);
    expect(await pending).toEqual({ text: null });
    expect(await predict()).toEqual({ text: null });
    composer.modelCallEnded("normal-chat");
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?" });
  });
  it("rejects public destinations and does not retry or fall back on failure", async () => {
    vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", "company-fast/followup-v2");
    const { predict, values } = setup("company-fast", "followup-v2");
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
