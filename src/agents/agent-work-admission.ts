import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

type AgentWorkState = { admissions: Set<object>; mutation?: object };
const states = resolveGlobalMap<string, AgentWorkState>(
  Symbol.for("openclaw.agentWorkAdmission"),
  "close-and-restart",
);

function ownerKey(agentId: string): string {
  if (!agentId.trim()) {
    throw new Error("Agent work admission requires an agent owner.");
  }
  return normalizeAgentId(agentId);
}

function releaseToken(agentId: string, state: AgentWorkState, token: object): void {
  state.admissions.delete(token);
  if (state.mutation === token) {
    delete state.mutation;
  }
  // A lifecycle reset may have replaced this owner's state while an old lease
  // was unwinding. That lease must never delete the replacement owner's fence.
  if (!state.admissions.size && !state.mutation && states.get(agentId) === state) {
    states.delete(agentId);
  }
}

/** Claims work synchronously, before preparation or queueing can yield. */
export function beginAgentWorkAdmission(agentId: string): () => void {
  const key = ownerKey(agentId);
  const state: AgentWorkState = states.get(key) ?? { admissions: new Set<object>() };
  if (state.mutation) {
    throw new Error(
      `Agent "${key}" is changing its execution environment. Retry when it completes.`,
    );
  }
  const token = {};
  state.admissions.add(token);
  states.set(key, state);
  return () => releaseToken(key, state, token);
}

export async function withAgentWorkAdmission<T>(
  agentId: string,
  run: () => Promise<T>,
): Promise<T> {
  const release = beginAgentWorkAdmission(agentId);
  try {
    return await run();
  } finally {
    release();
  }
}

export function hasPendingAgentWork(agentId: string): boolean {
  return Boolean(states.get(ownerKey(agentId))?.admissions.size);
}

/** Returns an exclusive fence only when no admitted work or mutation exists. */
export function tryAcquireAgentWorkMutation(agentId: string): (() => void) | null {
  const key = ownerKey(agentId);
  const state: AgentWorkState = states.get(key) ?? { admissions: new Set<object>() };
  if (state.admissions.size || state.mutation) {
    return null;
  }
  const token = {};
  state.mutation = token;
  states.set(key, state);
  return () => releaseToken(key, state, token);
}
