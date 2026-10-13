import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getActiveAgentRunContext } from "./agent-run-registry.js";

type ToolOwner = { agentId: string; sessionKey: string; runId?: string; abortSignal?: AbortSignal };
type AgentToolInvocation = {
  agentId: string;
  sessionKey: string;
  runId: string;
  abortSignal: AbortSignal;
  active: boolean;
  record: ReturnType<typeof getActiveAgentRunContext>;
};
const INVOCATION_KEY = Symbol.for("openclaw.agentToolInvocation");
// SDK/runtime module copies must observe the wrapper's one process-owned invocation scope.
const activeToolInvocation = resolveGlobalSingleton<AsyncLocalStorage<AgentToolInvocation>>(
  INVOCATION_KEY,
  () => new AsyncLocalStorage<AgentToolInvocation>(),
);

/** Host-sealed authority; its liveness callback never crosses a transport boundary. */
type ActiveAgentRunAuthorization = Readonly<{
  agentId: string;
  sessionKey: string;
  runtimeRunId: string;
  admissionRunId: string;
  isActive: () => boolean;
}>;

/** Called by the actual host tool wrapper, never by model parameters or transport IDs. */
export async function withActiveAgentToolInvocation<T>(
  owner: ToolOwner,
  toolSignal: AbortSignal | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  if (!owner.runId || !owner.abortSignal) {
    return await execute();
  }
  const invocation = {
    agentId: owner.agentId,
    sessionKey: owner.sessionKey,
    runId: owner.runId,
    // A per-call timeout can end tool authority before the parent run finishes.
    abortSignal: toolSignal ? AbortSignal.any([owner.abortSignal, toolSignal]) : owner.abortSignal,
    active: true,
    record: getActiveAgentRunContext(owner.runId),
  };
  try {
    return await activeToolInvocation.run(invocation, execute);
  } finally {
    invocation.active = false;
  }
}

export function resolveActiveAgentRunAuthorization(context: {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
}): ActiveAgentRunAuthorization | undefined {
  const invocation = activeToolInvocation.getStore();
  const runId = context.runId;
  if (
    !runId ||
    !invocation?.active ||
    invocation.runId !== runId ||
    invocation.agentId !== context.agentId ||
    invocation.sessionKey !== context.sessionKey
  ) {
    return undefined;
  }
  const record = getActiveAgentRunContext(runId);
  if (
    !record ||
    record !== invocation.record ||
    record.agentId !== invocation.agentId ||
    record.sessionKey !== invocation.sessionKey
  ) {
    return undefined;
  }
  const agentId = invocation.agentId;
  const sessionKey = invocation.sessionKey;
  const startedAt = record.lifecycleStartedAt;
  // A root run's registered identity is its admission; only a verified record may supply it.
  const admissionRunId = record.admissionRunId ?? runId;
  const isActive = () =>
    invocation.active &&
    !invocation.abortSignal.aborted &&
    getActiveAgentRunContext(runId) === record &&
    record.agentId === agentId &&
    record.sessionKey === sessionKey &&
    record.lifecycleStartedAt === startedAt &&
    (record.admissionRunId ?? runId) === admissionRunId;
  return isActive()
    ? Object.freeze({ agentId, sessionKey, runtimeRunId: runId, admissionRunId, isActive })
    : undefined;
}
