import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { toErrorObject } from "../../infra/errors.js";
import { resolveSubagentCompletionResultText } from "../subagent-completion-result.js";
import { observeSubagentRegistryChanges } from "../subagent-registry-state.js";
import { getSubagentRunsByRunIds } from "../subagent-registry.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";
import { resolveSwarmConfig } from "../swarm-config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const MAX_WAIT_IDS = 1_000;

const AgentsWaitToolSchema = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_WAIT_IDS }),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  required: Type.Optional(
    Type.Boolean({
      description:
        "Collect all authorized requested results until settlement or cancellation; mutually exclusive with timeoutSeconds. Child and run deadlines still apply.",
    }),
  ),
});

type WaitError = { runId: string; error: "not_found" | "not_owner" };
type WaitTarget = { runId: string; entry: SubagentRunRecord };

function ownsRun(entry: SubagentRunRecord, currentSessionKeys: ReadonlySet<string>): boolean {
  const owner = entry.swarmRequesterSessionKey?.trim();
  if (!owner) {
    return false;
  }
  const authorizedSessionKeys =
    entry.swarmWaitOwnerSessionKeys && entry.swarmWaitOwnerSessionKeys.length > 0
      ? entry.swarmWaitOwnerSessionKeys
      : [owner];
  return authorizedSessionKeys.some((sessionKey) => currentSessionKeys.has(sessionKey));
}

function completionResult(entry: SubagentRunRecord) {
  const completion = entry.collectorCompletion;
  if (!completion) {
    return undefined;
  }
  return {
    runId: entry.swarmRunId ?? entry.runId,
    status: completion.status,
    result: resolveSubagentCompletionResultText(entry) ?? "",
    ...(completion.structured !== undefined ? { structured: completion.structured } : {}),
    ...(completion.schemaError ? { schemaError: completion.schemaError } : {}),
    sessionKey: entry.childSessionKey,
    ...(entry.label ? { label: entry.label } : {}),
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
}

export type CollectorCompletionResult = NonNullable<ReturnType<typeof completionResult>>;

/** Park one host bridge until its collector completes; local writes and persisted-state observations wake it. */
export async function waitForCollectorCompletion(params: {
  runId: string;
  currentSessionKeys: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<CollectorCompletionResult> {
  try {
    const state = await waitForCollector({ ...params, ids: [params.runId], waitForAll: true });
    const error = state.errors?.[0];
    if (error) {
      throw new ToolInputError(`agents.run ${error.error}: ${error.runId}`);
    }
    const completion = state.completed[0];
    if (!completion) {
      throw new ToolInputError("agents.run result is unavailable.");
    }
    return completion;
  } catch (error) {
    if (params.signal?.aborted) {
      throw new ToolInputError("agents.run wait aborted.");
    }
    throw error;
  }
}

function resolveWaitTargets(ids: readonly string[], currentSessionKeys: ReadonlySet<string>) {
  const targets: WaitTarget[] = [];
  const errors: WaitError[] = [];
  const snapshot = getSubagentRunsByRunIds(ids);
  for (const runId of ids) {
    const entry = snapshot.entries.get(runId);
    if (!entry?.collect) {
      errors.push({ runId, error: "not_found" });
    } else if (!ownsRun(entry, currentSessionKeys)) {
      errors.push({ runId, error: "not_owner" });
    } else {
      targets.push({ runId, entry });
    }
  }
  return { targets, errors };
}

function readResolvedWaitState(targets: readonly WaitTarget[], errors: readonly WaitError[]) {
  const completed: Array<{
    result: NonNullable<ReturnType<typeof completionResult>>;
    completedAt: number;
    inputIndex: number;
  }> = [];
  const pending: string[] = [];
  for (const [inputIndex, { runId, entry }] of targets.entries()) {
    const result = completionResult(entry);
    if (result) {
      completed.push({
        result,
        completedAt:
          entry.completion?.capturedAt ?? entry.execution.endedAt ?? Number.MAX_SAFE_INTEGER,
        inputIndex,
      });
    } else {
      pending.push(runId);
    }
  }
  completed.sort(
    (left, right) => left.completedAt - right.completedAt || left.inputIndex - right.inputIndex,
  );
  return {
    completed: completed.map((entry) => entry.result),
    pending,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function readWaitState(ids: readonly string[], currentSessionKeys: ReadonlySet<string>) {
  const resolved = resolveWaitTargets(ids, currentSessionKeys);
  return readResolvedWaitState(resolved.targets, resolved.errors);
}

async function waitForCollector(params: {
  ids: readonly string[];
  currentSessionKeys: ReadonlySet<string>;
  timeoutMs?: number;
  waitForAll?: boolean;
  signal?: AbortSignal;
}) {
  if (params.signal?.aborted) {
    throw createAbortError("agents_wait aborted.");
  }
  return await new Promise<ReturnType<typeof readWaitState>>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (state?: ReturnType<typeof readWaitState>, error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      params.signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        reject(toErrorObject(error, "agents_wait failed."));
      } else if (state) {
        resolve(state);
      }
    };
    const check = (timedOut = false) => {
      try {
        if (params.signal?.aborted) {
          throw createAbortError("agents_wait aborted.");
        }
        // Recovery can replace a registry row or revoke ownership. Read the
        // authoritative registry on each event, never retain old row objects.
        const state = readWaitState(params.ids, params.currentSessionKeys);
        if (
          timedOut ||
          state.pending.length === 0 ||
          (!params.waitForAll && state.completed.length > 0)
        ) {
          finish(state);
        }
      } catch (error) {
        finish(undefined, error);
      }
    };
    const onAbort = () => finish(undefined, createAbortError("agents_wait aborted."));
    const unsubscribe = observeSubagentRegistryChanges(() => check());
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.timeoutMs !== undefined && params.timeoutMs > 0) {
      timer = setTimeout(() => check(true), params.timeoutMs);
    }
    // Subscribe before reading to close completion and abort registration races.
    check(params.timeoutMs === 0);
  });
}

export function createAgentsWaitTool(opts: {
  agentSessionKey?: string;
  runSessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  const swarm = resolveSwarmConfig(opts.config, opts.agentId);
  return {
    label: "Wait for Agents",
    name: "agents_wait",
    displaySummary: "Wait for collector children.",
    description:
      "Wait for collector subagents started by sessions_spawn collect=true. Accepts many run ids; returns once any completes (completed results incl. structured output, plus pending ids), or on timeoutSeconds. Set required=true to retain all authorized requested results until terminal collection without model polling.",
    parameters: AgentsWaitToolSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as { ids: string[]; timeoutSeconds?: number; required?: boolean };
      if (params.required !== undefined && typeof params.required !== "boolean") {
        throw new ToolInputError("agents_wait required must be a boolean.");
      }
      if (params.required && params.timeoutSeconds !== undefined) {
        throw new ToolInputError("required agents_wait cannot also specify timeoutSeconds.");
      }
      if (params.ids.length > MAX_WAIT_IDS) {
        throw new ToolInputError(`agents_wait supports at most ${MAX_WAIT_IDS} ids.`);
      }
      const ids = [...new Set(params.ids.map((id) => id.trim()).filter(Boolean))];
      if (ids.length === 0) {
        throw new ToolInputError("agents_wait requires at least one non-empty run id.");
      }
      const currentSessionKeys = new Set(
        [opts.runSessionKey, opts.agentSessionKey].filter((key): key is string =>
          Boolean(key?.trim()),
        ),
      );
      const requestedTimeout =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? params.timeoutSeconds
          : 30;
      const timeoutSeconds = Math.min(Math.max(0, requestedTimeout), swarm.waitTimeoutSecondsMax);
      const result = await waitForCollector({
        ids,
        currentSessionKeys,
        timeoutMs: params.required ? undefined : timeoutSeconds * 1_000,
        waitForAll: params.required,
        signal,
      });
      const noAuthorizedTargets =
        result.completed.length === 0 &&
        result.pending.length === 0 &&
        Boolean(result.errors?.length);
      return jsonResult(noAuthorizedTargets ? { ...result, success: false } : result);
    },
  };
}

const testing = {
  ownsRun,
  readResolvedWaitState,
  readWaitState,
  resolveWaitTargets,
  waitForCollector,
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.agentsWaitToolTestApi")] = {
    testing,
  };
}
