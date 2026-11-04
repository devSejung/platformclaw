import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
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
  const model: ModelDefinitionConfig = {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  const provider: {
    baseUrl: string;
    api: string;
    apiKey?: unknown;
    headers?: Record<string, unknown>;
    models: ModelDefinitionConfig[];
  } = {
    baseUrl: "http://company.internal/v1",
    api: apiType,
    models: [model],
  };
  const config = {
    plugins: { entries: { "admin-http-rpc": { config: pluginConfig } } },
    models: {
      providers: {
        [providerId]: provider,
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
  return { call, predict, composer, values, params, pluginConfig, provider, model };
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
    expect(await predict()).toEqual({ text: null, reason: "disabled" });
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
    expect(await call({ ...params, userId: "user-2" }, signal)).toEqual({
      text: null,
      reason: "disabled",
    });
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?", reason: "suggested" });
    const request = mocks.fetch.mock.calls[0]?.[0];
    const body = JSON.parse(request.init.body);
    expect(body).toMatchObject({ model: "codellm-fast", stream: false });
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(160);
    expect(body.tools).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
    expect(request.capture).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("sends eight bounded visible messages as task data and keeps credentials out of the prompt", async () => {
    const { predict, values, params, provider } = setup("CodeMate");
    values.set("user-1", true);
    provider.apiKey = "synthetic-provider-key";
    params.messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index === 7 ? "😀".repeat(2_000) : `turn ${index}: ${"문".repeat(1_000)}`,
    }));
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?", reason: "suggested" });
    const request = mocks.fetch.mock.calls[0]?.[0];
    const body = JSON.parse(request.init.body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("never as the assistant"),
    });
    expect(body.messages[0].content).toContain("two short sentences and 500 characters");
    expect(body.messages[1].role).toBe("user");
    expect(JSON.parse(body.messages[1].content)).toEqual(
      params.messages.map((message) => ({ role: message.role, text: message.content })),
    );
    expect(request.init.headers.get("Authorization")).toBe("Bearer synthetic-provider-key");
    expect(request.init.body).not.toContain("synthetic-provider-key");
    expect(request.maxRedirects).toBe(0);
    expect(request.dispatcherPolicy).toEqual({
      mode: "direct",
      pinnedHostname: { hostname: "company.internal", addresses: ["10.1.2.3"] },
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { format: "qwen" as const, expected: { enable_thinking: false } },
    {
      format: "qwen-chat-template" as const,
      expected: { chat_template_kwargs: { enable_thinking: false } },
    },
    { format: "openai" as const, expected: { reasoning_effort: "none" } },
    { format: "openrouter" as const, expected: { reasoning: { effort: "none" } } },
  ])("uses canonical thinking-off request shaping for $format", async ({ format, expected }) => {
    const { predict, values, model } = setup();
    values.set("user-1", true);
    model.reasoning = true;
    model.compat = {
      thinkingFormat: format,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high"],
      maxTokensField: "max_tokens",
    };
    await predict();
    const body = JSON.parse(mocks.fetch.mock.calls[0]?.[0].init.body);
    expect(body).toMatchObject({ ...expected, max_tokens: 160, stream: false });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
  });
  it("does not invent a thinking-off wire flag for an opaque model without a declared dialect", async () => {
    const { predict, values, model } = setup();
    values.set("user-1", true);
    model.reasoning = true;
    model.compat = { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "high"] };
    await predict();
    const body = JSON.parse(mocks.fetch.mock.calls[0]?.[0].init.body);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
    expect(body.chat_template_kwargs).toBeUndefined();
  });
  it.each(["account", "server"] as const)(
    "does not send context after %s opt-out while DNS is pending",
    async (scope) => {
      const { call, predict, values, pluginConfig } = setup();
      values.set("user-1", true);
      const addresses = [{ address: "10.1.2.3", family: 4 }];
      let resolveLookup: ((value: typeof addresses) => void) | undefined;
      mocks.lookup.mockImplementationOnce(
        () =>
          new Promise<typeof addresses>((resolve) => {
            resolveLookup = resolve;
          }),
      );
      const pending = predict();
      await vi.waitFor(() => expect(resolveLookup).toBeDefined());
      if (scope === "account") {
        expect(
          await call(
            { action: "preferences", userId: "user-1", enabled: false },
            new AbortController().signal,
          ),
        ).toMatchObject({ enabled: false });
      } else {
        pluginConfig.composerPredictionsEnabled = false;
      }
      resolveLookup?.(addresses);
      expect(await pending).toEqual({ text: null, reason: "disabled" });
      expect(mocks.fetch).not.toHaveBeenCalled();
      pluginConfig.composerPredictionsEnabled = true;
      values.set("user-1", true);
      expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?", reason: "suggested" });
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    },
  );
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
      expect(await predict()).toEqual({ text: null, reason: "disabled" });
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
    expect(await pending).toEqual({ text: "다음 단계는 무엇인가요?", reason: "suggested" });
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
    expect(await pending).toEqual({ text: null, reason: "timeout" });
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?", reason: "suggested" });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("preserves request cancellation when normal chat starts during stream cleanup", async () => {
    const { predict, composer, values } = setup();
    values.set("user-1", true);
    const release = vi.fn(async () => {
      composer.modelCallStarted("normal-chat");
    });
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
    cancellation.abort(new Error("private request cancellation reason"));
    expect(await pending).toEqual({ text: null, reason: "cancelled" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(await predict()).toEqual({ text: null, reason: "model_busy" });
    composer.modelCallEnded("normal-chat");
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?", reason: "suggested" });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("uses the configured provider/model and pins it until plugin recreation", async () => {
    vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", "  company-fast/org/followup-v2  ");
    const { predict, values } = setup("company-fast", "org/followup-v2");
    values.set("user-1", true);
    vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", "codemate/codellm-fast");
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?", reason: "suggested" });
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
      expect(await predict()).toEqual({ text: null, reason: "model_unavailable" });
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.lookup).not.toHaveBeenCalled();
    },
  );
  it("rejects an unsupported API on the selected provider", async () => {
    vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", "company-fast/followup-v2");
    const { predict, values } = setup("company-fast", "followup-v2", "anthropic-messages");
    values.set("user-1", true);
    expect(await predict()).toEqual({ text: null, reason: "unsupported_api" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["malformed URL", "not a URL"],
    // A redacted fixture password still exercises the URL userinfo rejection.
    ["embedded credentials", "http://example-user:***@provider.example.test/v1"],
    ["query credentials", "http://company.internal/v1?key=private-key"],
  ])(
    "reports an invalid provider for %s without exposing its configuration",
    async (_name, baseUrl) => {
      const { predict, values, provider } = setup();
      values.set("user-1", true);
      provider.baseUrl = baseUrl;
      expect(await predict()).toEqual({ text: null, reason: "invalid_provider" });
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.lookup).not.toHaveBeenCalled();
    },
  );
  it.each(["apiKey", "headers"] as const)(
    "reports unresolved %s without exposing the credential reference",
    async (field) => {
      const { predict, values, provider } = setup();
      values.set("user-1", true);
      const credential = { source: "env", id: "PRIVATE_CREDENTIAL" };
      if (field === "apiKey") {
        provider.apiKey = credential;
      } else {
        provider.headers = { Authorization: credential };
      }
      expect(await predict()).toEqual({ text: null, reason: "credentials_unready" });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { name: "missing messages", messages: undefined },
    { name: "empty history", messages: [] },
    { name: "short history", messages: [{ role: "assistant", content: "답변" }] },
    {
      name: "disallowed role",
      messages: [
        { role: "system", content: "private context" },
        { role: "assistant", content: "답변" },
      ],
    },
    {
      name: "oversized message",
      messages: [
        { role: "user", content: "x".repeat(2_001) },
        { role: "assistant", content: "답변" },
      ],
    },
    {
      name: "oversized Unicode message",
      messages: [
        { role: "user", content: "😀".repeat(2_001) },
        { role: "assistant", content: "답변" },
      ],
    },
    {
      name: "too many messages",
      messages: Array.from({ length: 9 }, () => ({ role: "assistant", content: "답변" })),
    },
    {
      name: "missing user turn",
      messages: [
        { role: "assistant", content: "답변" },
        { role: "assistant", content: "추가 답변" },
      ],
    },
    {
      name: "unfinished response",
      messages: [
        { role: "assistant", content: "답변" },
        { role: "user", content: "계획" },
      ],
    },
  ])("reports $name as invalid context without inference", async ({ messages }) => {
    const { call, values, params } = setup();
    values.set("user-1", true);
    expect(await call({ ...params, messages }, new AbortController().signal)).toEqual({
      text: null,
      reason: "invalid_context",
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500, 503])(
    "returns only the provider status for HTTP %s and releases admission",
    async (status) => {
      const { predict, values } = setup();
      values.set("user-1", true);
      const cancel = vi.fn();
      const release = vi.fn(async () => {});
      mocks.fetch.mockResolvedValueOnce({
        response: new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("private provider body and prompt"));
            },
            cancel,
          }),
          { status, headers: { "X-Private-Credential": "private-key" } },
        ),
        release,
      });
      expect(await predict()).toEqual({
        text: null,
        reason: "provider_http_error",
        providerStatus: status,
      });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?", reason: "suggested" });
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    { name: "missing body", body: null, reason: "response_missing" },
    { name: "empty body", body: "  ", reason: "response_empty" },
    { name: "malformed JSON", body: "private non-JSON provider error", reason: "response_invalid" },
    { name: "missing choices", body: "{}", reason: "response_invalid" },
    { name: "oversized body", body: "x".repeat(16_385), reason: "response_oversized" },
    ...[
      {
        name: "non-text content",
        content: { private: "provider output" },
        reason: "response_invalid",
      },
      {
        name: "structured content outside the string-response contract",
        content: [
          { type: "reasoning", text: "private reasoning" },
          { type: "text", text: "다음 단계는 무엇인가요?" },
        ],
        reason: "response_invalid",
      },
      { name: "empty content", content: "  ", reason: "response_empty" },
      { name: "intentional abstention", content: "NO_SUGGESTION", reason: "no_suggestion" },
      { name: "long content", content: "x".repeat(501), reason: "format_rejected" },
      {
        name: "unfinished reasoning",
        content: "<think>private reasoning",
        reason: "response_empty",
      },
      {
        name: "reasoning followed by abstention",
        content: "<think>private reasoning</think>NO_SUGGESTION",
        reason: "no_suggestion",
      },
    ].map(({ name, content, reason }) => ({
      name,
      body: JSON.stringify({ choices: [{ message: { content } }] }),
      reason,
    })),
  ])("reports $name without returning rejected output", async ({ body, reason }) => {
    const { predict, values } = setup();
    values.set("user-1", true);
    const release = vi.fn(async () => {});
    mocks.fetch.mockResolvedValueOnce({ response: new Response(body), release });
    expect(await predict()).toEqual({ text: null, reason });
    expect(release).toHaveBeenCalledTimes(1);
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?", reason: "suggested" });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, "stop", "length"])(
    "returns only visible output for compatible finish reason %s",
    async (finishReason) => {
      const { predict, values } = setup();
      values.set("user-1", true);
      const text = "다음 단계는 무엇인가요?\n기존 제약도 유지해주세요.";
      mocks.fetch.mockResolvedValueOnce({
        response: Response.json({
          choices: [
            {
              finish_reason: finishReason,
              message: {
                content: `<think>private inline reasoning</think><final>${text}</final>`,
                reasoning_content: "private native reasoning",
                reasoning: "private alternate reasoning",
                tool_calls: [],
                refusal: null,
              },
            },
          ],
        }),
        release: async () => {},
      });
      expect(await predict()).toEqual({ text, reason: "suggested" });
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("retains the upstream five-hundred-character output budget", async () => {
    const { predict, values } = setup();
    values.set("user-1", true);
    const text = "문".repeat(500);
    mocks.fetch.mockResolvedValueOnce({
      response: Response.json({ choices: [{ finish_reason: "stop", message: { content: text } }] }),
      release: async () => {},
    });
    expect(await predict()).toEqual({ text, reason: "suggested" });
  });
  it.each([
    {
      name: "final wrapper",
      content: "<final>\n다음 단계는 무엇인가요?\n</final>",
      text: "다음 단계는 무엇인가요?",
    },
    {
      name: "literal reasoning tags in code",
      content: "`<think>literal</think>` 문자열도 유지해줘.",
      text: "`<think>literal</think>` 문자열도 유지해줘.",
    },
    {
      name: "literal final tags in code",
      content: "`<final>literal</final>` 문자열도 유지해줘.",
      text: "`<final>literal</final>` 문자열도 유지해줘.",
    },
  ])("preserves visible text for $name", async ({ content, text }) => {
    const { predict, values } = setup();
    values.set("user-1", true);
    mocks.fetch.mockResolvedValueOnce({
      response: Response.json({ choices: [{ finish_reason: "stop", message: { content } }] }),
      release: async () => {},
    });
    expect(await predict()).toEqual({ text, reason: "suggested" });
  });
  it.each([
    { finish_reason: null },
    { finish_reason: "tool_calls" },
    { finish_reason: "content_filter" },
    { finish_reason: "error" },
    { finish_reason: "stop", message: { tool_calls: [{ id: "call-1", type: "function" }] } },
    { finish_reason: "stop", message: { function_call: { name: "private-tool" } } },
    { finish_reason: "stop", message: { refusal: "private provider refusal" } },
  ])("rejects unfinished or non-answer output without retry (%j)", async (choice) => {
    const { predict, values } = setup();
    values.set("user-1", true);
    const release = vi.fn(async () => {});
    mocks.fetch.mockResolvedValueOnce({
      response: Response.json({
        choices: [{ ...choice, message: { content: "visible-looking output", ...choice.message } }],
      }),
      release,
    });
    expect(await predict()).toEqual({ text: null, reason: "response_invalid" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("reports preferences disabled during inference without returning the suggestion", async () => {
    const { predict, values } = setup();
    values.set("user-1", true);
    mocks.fetch.mockImplementationOnce(async () => {
      values.set("user-1", false);
      return {
        response: Response.json({ choices: [{ message: { content: "private suggestion" } }] }),
        release: async () => {},
      };
    });
    expect(await predict()).toEqual({ text: null, reason: "disabled" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
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
    expect(await predict()).toEqual({ text: null, reason: "prediction_busy" });
    composer.modelCallStarted("normal-chat");
    expect(abortSignal?.aborted).toBe(true);
    expect(await pending).toEqual({ text: null, reason: "model_preempted" });
    expect(await predict()).toEqual({ text: null, reason: "model_busy" });
    composer.modelCallEnded("normal-chat");
    expect(await predict()).toEqual({ text: "다음 단계는 무엇인가요?", reason: "suggested" });
  });
  it("rejects public destinations and does not retry or fall back on failure", async () => {
    vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", "company-fast/followup-v2");
    const { predict, values } = setup("company-fast", "followup-v2");
    values.set("user-1", true);
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    expect(await predict()).toEqual({ text: null, reason: "destination_rejected" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.fetch.mockRejectedValueOnce(new Error("TimeoutError: secret credential and prompt"));
    expect(await predict()).toEqual({ text: null, reason: "provider_error" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("forwards cancellation without leaking the response", async () => {
    const { predict, values } = setup();
    values.set("user-1", true);
    const controller = new AbortController();
    controller.abort();
    expect(await predict(controller.signal)).toEqual({ text: null, reason: "cancelled" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
