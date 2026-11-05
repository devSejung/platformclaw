import type { Model, Usage } from "@openclaw/llm-core";
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { applyProviderReportedUsageCost, calculateCost } from "../model-utils.js";

export type OpenAICompletionsUsageTarget = {
  usage: Usage & { reasoningTokens?: number };
  openclawUsageProvenance?: "unmeasured" | "partial";
};

type RawOpenAICompletionsUsage = NonNullable<ChatCompletionChunk["usage"]> & {
  cost?: unknown;
  prompt_cache_hit_tokens?: number;
};

type OpenAICompletionsUsageOptions = { includeReasoningTokens?: boolean };

function readOpenAICompletionsUsage(
  rawUsage: RawOpenAICompletionsUsage,
  model: Model,
  options?: OpenAICompletionsUsageOptions,
): OpenAICompletionsUsageTarget {
  const prompt = parseStrictNonNegativeInteger(rawUsage.prompt_tokens);
  const completion = parseStrictNonNegativeInteger(rawUsage.completion_tokens);
  const providerTotal = parseStrictNonNegativeInteger(rawUsage.total_tokens);
  const cached =
    parseStrictNonNegativeInteger(rawUsage.prompt_tokens_details?.cached_tokens) ??
    parseStrictNonNegativeInteger(rawUsage.prompt_cache_hit_tokens);
  const cacheWritten = parseStrictNonNegativeInteger(
    rawUsage.prompt_tokens_details?.cache_write_tokens,
  );
  const cacheRead = cached ?? 0;
  const cacheWrite = cacheWritten ?? 0;
  const input = Math.max(0, (prompt ?? 0) - cacheRead - cacheWrite);
  const output = completion ?? 0;
  const componentTotal = input + output + cacheRead + cacheWrite;
  const hasCompleteComponents = prompt !== undefined && completion !== undefined;
  // Compatible providers can report an aggregate independently of its components.
  // Reject totals smaller than the recorded subtotal, including cache overflow.
  const measuredAggregate =
    providerTotal !== undefined && providerTotal >= componentTotal ? providerTotal : undefined;
  const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens;
  const usage: OpenAICompletionsUsageTarget["usage"] = {
    input,
    output,
    cacheRead,
    cacheWrite,
    // Managed transport exposes reasoning telemetry; the shipped package Usage shape does not.
    ...(options?.includeReasoningTokens !== false &&
    typeof reasoningTokens === "number" &&
    Number.isFinite(reasoningTokens)
      ? { reasoningTokens }
      : {}),
    totalTokens: measuredAggregate ?? componentTotal,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  applyProviderReportedUsageCost(usage, rawUsage.cost);
  if (hasCompleteComponents || measuredAggregate !== undefined) {
    return { usage };
  }
  const hasComponents = [prompt, completion, cached, cacheWritten].some(
    (count) => count !== undefined,
  );
  return { usage, openclawUsageProvenance: hasComponents ? "partial" : "unmeasured" };
}

export function applyOpenAICompletionsUsage(
  target: OpenAICompletionsUsageTarget,
  rawUsage: RawOpenAICompletionsUsage,
  model: Model,
  options?: OpenAICompletionsUsageOptions,
): void {
  const sample = readOpenAICompletionsUsage(rawUsage, model, options);
  if (
    sample.openclawUsageProvenance &&
    (target.openclawUsageProvenance === undefined ||
      (sample.openclawUsageProvenance === "unmeasured" &&
        target.openclawUsageProvenance === "partial"))
  ) {
    if (sample.usage.cost.totalOrigin === "provider-billed") {
      applyProviderReportedUsageCost(target.usage, sample.usage.cost.total);
    }
    return;
  }
  target.usage = sample.usage;
  if (sample.openclawUsageProvenance) {
    target.openclawUsageProvenance = sample.openclawUsageProvenance;
  } else {
    delete target.openclawUsageProvenance;
  }
}

export function parseOpenAICompletionsUsage(
  rawUsage: RawOpenAICompletionsUsage,
  model: Model,
  options?: OpenAICompletionsUsageOptions,
): OpenAICompletionsUsageTarget["usage"] {
  return readOpenAICompletionsUsage(rawUsage, model, options).usage;
}
