import type { Context, Model } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  resolveOpenAICompletionsCompat,
  type ResolvedOpenAICompletionsCompat,
} from "./openai-completions-compat.js";
import { buildOpenAICompletionsParams } from "./openai-completions-transport.js";
import { buildOpenAIResponsesParams } from "./openai-responses-params-internal.js";
import { getCompat } from "./openai-transport-params.js";

const initialHost = getAiTransportHost();
const context: Context = {
  messages: [{ role: "user", content: "A small test conversation.", timestamp: 1 }],
};
const frozenModel = Object.freeze({
  id: "test-model",
  name: "Test model",
  api: "openai-completions" as const,
  provider: "test-proxy",
  baseUrl: "https://proxy.example/v1",
  reasoning: true,
  input: Object.freeze(["text" as const]),
  cost: Object.freeze({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tieredPricing: Object.freeze([
      Object.freeze({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        // Runtime config's deep-readonly view widens tuples to readonly arrays.
        range: Object.freeze([0, 2048]),
      }),
      Object.freeze({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        range: Object.freeze([2048]),
      }),
    ]),
  }),
  contextWindow: 4096,
  maxTokens: 4096,
  thinkingLevelMap: Object.freeze({ off: "none" }),
  params: Object.freeze({ metadata: Object.freeze({ tags: Object.freeze(["fixture"]) }) }),
  compat: Object.freeze({
    thinkingFormat: "openai" as const,
    supportsReasoningEffort: true,
    maxTokensField: "max_completion_tokens" as const,
    openRouterRouting: Object.freeze({
      order: Object.freeze(["provider-a", "provider-b"]),
      only: Object.freeze(["provider-a"]),
      ignore: Object.freeze(["provider-c"]),
      quantizations: Object.freeze(["fp16", "bf16"]),
      sort: Object.freeze({ by: "latency", partition: "model" }),
      max_price: Object.freeze({ prompt: 1, completion: "2" }),
    }),
    vercelGatewayRouting: Object.freeze({
      only: Object.freeze(["provider-a"]),
      order: Object.freeze(["provider-a", "provider-b"]),
    }),
    visibleReasoningDetailTypes: Object.freeze(["response.output_text", "response.text"]),
    unsupportedToolSchemaKeywords: Object.freeze(["patternProperties"]),
    reasoningEffortMap: Object.freeze({ off: "none" }),
  }),
});

beforeEach(() => {
  configureAiTransportHost({
    ...initialHost,
    resolveProviderRequestCapabilities: () => ({
      endpointClass: "custom",
      knownProviderFamily: "unknown",
      supportsNativeStreamingUsageCompat: false,
      supportsOpenAICompletionsStreamingUsageCompat: false,
      usesExplicitProxyLikeEndpoint: true,
      allowsAnthropicServiceTier: false,
    }),
  });
});

afterEach(() => {
  configureAiTransportHost(initialHost);
});

describe("OpenAI model input ownership", () => {
  it("accepts nested readonly model data directly in the parameter builder", () => {
    expectTypeOf(frozenModel).toMatchTypeOf<Parameters<typeof buildOpenAICompletionsParams>[0]>();
    expectTypeOf<Parameters<typeof buildOpenAICompletionsParams>[0]["api"]>().toEqualTypeOf<
      Model["api"]
    >();
    expectTypeOf<(typeof frozenModel.cost.tieredPricing)[number]["range"]>().toEqualTypeOf<
      readonly number[]
    >();

    const params = buildOpenAICompletionsParams(frozenModel, context, {
      reasoning: "none",
      maxTokens: 160,
      cacheRetention: "none",
    });

    expect(params).toMatchObject({
      model: "test-model",
      messages: [{ role: "user", content: "A small test conversation." }],
      max_completion_tokens: 160,
    });
  });

  it("preserves nested compatibility data without writing to a frozen model", () => {
    const compat = getCompat(frozenModel);
    expectTypeOf(compat.visibleReasoningDetailTypes).toEqualTypeOf<readonly string[]>();

    buildOpenAICompletionsParams(frozenModel, context, { reasoning: "none", maxTokens: 160 });

    expect(getCompat(frozenModel)).toEqual(compat);
    expect(compat.openRouterRouting).toEqual({
      order: ["provider-a", "provider-b"],
      only: ["provider-a"],
      ignore: ["provider-c"],
      quantizations: ["fp16", "bf16"],
      sort: { by: "latency", partition: "model" },
      max_price: { prompt: 1, completion: "2" },
    });
    expect(compat.vercelGatewayRouting).toEqual({
      only: ["provider-a"],
      order: ["provider-a", "provider-b"],
    });
    expect(compat.visibleReasoningDetailTypes).toEqual(["response.output_text", "response.text"]);
    expect(compat.reasoningEffortMap).toEqual({ off: "none" });
    expect(frozenModel.compat.unsupportedToolSchemaKeywords).toEqual(["patternProperties"]);
    expect(frozenModel.cost.tieredPricing.map((tier) => tier.range)).toEqual([[0, 2048], [2048]]);
    expect(frozenModel.params.metadata.tags).toEqual(["fixture"]);
    expect(frozenModel.thinkingLevelMap).toEqual({ off: "none" });
    expect(frozenModel.input).toEqual(["text"]);
  });

  it("keeps mutable model and resolved compatibility direct calls writable", () => {
    const model: Model<"openai-completions"> = {
      id: "mutable-model",
      name: "Mutable model",
      api: "openai-completions",
      provider: "test-proxy",
      baseUrl: "https://proxy.example/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 4096,
      compat: {
        openRouterRouting: { order: ["provider-a"], only: ["provider-a"] },
        vercelGatewayRouting: { order: ["provider-a"] },
      },
    };
    model.input.push("image");
    model.cost.input = 1;
    model.compat?.openRouterRouting?.order?.push("provider-b");

    const resolved = resolveOpenAICompletionsCompat(model);
    expectTypeOf(resolved).toEqualTypeOf<ResolvedOpenAICompletionsCompat>();
    resolved.visibleReasoningDetailTypes.push("response.text");
    resolved.openRouterRouting?.only?.push("provider-b");
    resolved.vercelGatewayRouting.order?.push("provider-b");

    const compat = getCompat(model);
    expectTypeOf(compat.visibleReasoningDetailTypes).toEqualTypeOf<string[]>();
    compat.visibleReasoningDetailTypes.push("response.output_text");
    compat.openRouterRouting.only = ["provider-c"];
    compat.vercelGatewayRouting.order = ["provider-c"];

    expect(buildOpenAICompletionsParams(model, context, { maxTokens: 160 }).model).toBe(
      "mutable-model",
    );
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost.input).toBe(1);
    expect(resolved.visibleReasoningDetailTypes).toEqual(["response.text"]);
    expect(compat.visibleReasoningDetailTypes).toEqual(["response.output_text"]);
    expect(compat.openRouterRouting.only).toEqual(["provider-c"]);
    expect(compat.vercelGatewayRouting.order).toEqual(["provider-c"]);
  });

  it("keeps the existing mutable Responses model and parameter output", () => {
    const model: Model<"openai-responses"> = {
      id: "responses-model",
      name: "Responses model",
      api: "openai-responses",
      provider: "test-proxy",
      baseUrl: "https://proxy.example/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 4096,
    };
    model.maxTokens = 2048;

    const params = buildOpenAIResponsesParams(model, context, { maxTokens: 160 });

    expect(params).toMatchObject({
      model: "responses-model",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "A small test conversation." }],
        },
      ],
      max_output_tokens: 160,
    });
    expect(model.maxTokens).toBe(2048);
  });
});
