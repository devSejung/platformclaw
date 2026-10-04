import type { Context, Model } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { buildOpenAICompletionsParams } from "./openai-completions-transport.js";

const initialHost = getAiTransportHost();
const logWarn = vi.fn();
const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "test-proxy",
  baseUrl: "https://proxy.example.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4_096,
  maxTokens: 4_096,
};

beforeEach(() => {
  logWarn.mockClear();
  configureAiTransportHost({
    ...initialHost,
    logWarn,
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

describe("OpenAI completions budget diagnostics", () => {
  it.each([15, 16])("warns only when clamping leaves fewer than 16 output tokens: %i", (output) => {
    const systemPrompt = "private-system-marker";
    const prompt = "private-user-marker";
    const context: Context = {
      systemPrompt,
      messages: [{ role: "user", content: prompt, timestamp: 1 }],
      tools: [],
    };
    const estimatedInput = Math.ceil(((systemPrompt.length + prompt.length) / 4) * 1.25);
    const effectiveContext = estimatedInput + output + 1;
    const params = buildOpenAICompletionsParams(
      { ...model, contextWindow: effectiveContext },
      context,
      undefined,
    );
    expect(params.max_completion_tokens).toBe(output);
    expect((params.max_completion_tokens as number) + estimatedInput + 1).toBe(effectiveContext);
    if (output === 15) {
      expect(logWarn).toHaveBeenCalledWith(
        "openai-transport",
        `[completions] insufficient_output_budget provider=test-proxy api=openai-completions ` +
          `model=test-model output=15 effectiveContext=${effectiveContext} estimatedInput=${estimatedInput}`,
        undefined,
      );
      expect(logWarn.mock.calls.flat().join(" ")).not.toContain("private-");
    } else {
      expect(logWarn).not.toHaveBeenCalled();
    }
  });

  it("counts the final system, messages, tools, and response schema without runtime metadata", () => {
    const tool = {
      name: "client_lookup",
      description: "private-tool-description",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      outputSchema: { description: "runtime-only-output ".repeat(4_000) },
      executionMode: "parallel",
    };
    const context: Context = {
      systemPrompt: "private-system-marker",
      messages: [{ role: "user", content: "private-user-marker", timestamp: 1 }],
      tools: [tool],
    };
    const options = {
      responseFormat: {
        type: "json_schema" as const,
        json_schema: {
          name: "answer",
          schema: { type: "object", properties: { value: { type: "string" } } },
        },
      },
    };
    const params = buildOpenAICompletionsParams(
      { ...model, compat: { supportsJsonSchemaResponseFormat: true } },
      context,
      options,
    );
    const messages = params.messages as Array<{ content: string }>;
    const serializedChars =
      messages.reduce((sum, message) => sum + message.content.length, 0) +
      JSON.stringify(params.tools).length +
      JSON.stringify(params.response_format).length;
    const estimatedInput = Math.ceil((serializedChars / 4) * 1.25);
    expect(params.max_completion_tokens).toBe(model.contextWindow - estimatedInput - 1);
    expect(JSON.stringify(params.tools)).not.toContain("runtime-only-output");
    expect(JSON.stringify(params.tools)).not.toContain("executionMode");
    expect(logWarn).not.toHaveBeenCalled();
  });
});
