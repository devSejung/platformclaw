import {
  formatErrorMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage, Usage } from "openclaw/plugin-sdk/llm";
import { resolveCodexLocalRuntimeAttribution } from "./local-runtime-attribution.js";

export type AssistantMessageOptions = {
  tokenUsage:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
        contextUsage?: Usage["contextUsage"];
      }
    | undefined;
  aborted: boolean;
  promptError: unknown;
  usageUnmeasured?: boolean;
};

export type CodexUsageProvenance = {
  openclawUsageProvenance?: "transcript-only" | "unmeasured" | "partial";
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export function createAssistantMessage(
  params: EmbeddedRunAttemptParams,
  text: string,
  options: AssistantMessageOptions,
): AssistantMessage & CodexUsageProvenance {
  const attribution = resolveCodexLocalRuntimeAttribution(params);
  const { tokenUsage } = options;
  const hasMeasuredTotal =
    tokenUsage?.total !== undefined ||
    (tokenUsage?.input !== undefined && tokenUsage.output !== undefined);
  const hasMeasuredComponents = [
    tokenUsage?.input,
    tokenUsage?.output,
    tokenUsage?.cacheRead,
    tokenUsage?.cacheWrite,
  ].some((value) => value !== undefined);
  const usage: Usage = tokenUsage
    ? {
        input: tokenUsage.input ?? 0,
        output: tokenUsage.output ?? 0,
        cacheRead: tokenUsage.cacheRead ?? 0,
        cacheWrite: tokenUsage.cacheWrite ?? 0,
        ...(tokenUsage.contextUsage ? { contextUsage: tokenUsage.contextUsage } : {}),
        totalTokens:
          tokenUsage.total ??
          (tokenUsage.input ?? 0) +
            (tokenUsage.output ?? 0) +
            (tokenUsage.cacheRead ?? 0) +
            (tokenUsage.cacheWrite ?? 0),
        cost: ZERO_USAGE.cost,
      }
    : ZERO_USAGE;
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: attribution.api ?? "openai-chatgpt-responses",
    provider: attribution.provider,
    model: params.modelId,
    usage,
    ...(options.usageUnmeasured || !hasMeasuredTotal
      ? {
          openclawUsageProvenance:
            !options.usageUnmeasured && hasMeasuredComponents ? "partial" : "unmeasured",
        }
      : {}),
    stopReason: options.aborted ? "aborted" : options.promptError ? "error" : "stop",
    errorMessage: options.promptError ? formatErrorMessage(options.promptError) : undefined,
    timestamp: Date.now(),
  };
}

export function createAssistantCommentaryMessage(
  params: EmbeddedRunAttemptParams,
  text: string,
  itemId: string,
  timestamp: number,
): AssistantMessage {
  const attribution = resolveCodexLocalRuntimeAttribution(params);
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: attribution.api ?? "openai-chatgpt-responses",
    provider: attribution.provider,
    model: params.modelId,
    usage: ZERO_USAGE,
    openclawUsageProvenance: "transcript-only",
    stopReason: "stop",
    timestamp,
    // Keep this unphased: gateway history hides commentary-phase assistant rows.
    // The keyed fallback persists Control UI narration without channel delivery.
    openclawStreamFallback: {
      replacementText: text,
      source: "segment",
      itemId,
    },
  } as unknown as AssistantMessage;
}

export function createAssistantMirrorMessage(
  params: EmbeddedRunAttemptParams,
  title: string,
  text: string,
): AssistantMessage & CodexUsageProvenance {
  const attribution = resolveCodexLocalRuntimeAttribution(params);
  return {
    role: "assistant",
    content: [{ type: "text", text: `${title}:\n${text}` }],
    api: attribution.api ?? "openai-chatgpt-responses",
    provider: attribution.provider,
    model: params.modelId,
    usage: ZERO_USAGE,
    openclawUsageProvenance: "transcript-only",
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
