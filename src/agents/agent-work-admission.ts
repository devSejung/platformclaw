import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../shared/global-singleton.js";

type AgentWorkToken = { execution: boolean };
type AgentWorkState = {
  admissions: Set<AgentWorkToken>;
  mutation?: { createBusyError?: () => Error };
};
const states = resolveGlobalMap<string, AgentWorkState>(
  Symbol.for("openclaw.agentWorkAdmission"),
  "close-and-restart",
);
const currentAdmissions = resolveGlobalSingleton(
  Symbol.for("openclaw.currentAgentWorkAdmissions"),
  () => new AsyncLocalStorage<ReadonlySet<AgentWorkToken> | undefined>(),
);

type AgentWorkAdmission = (() => void) & { run<T>(run: () => T): T };

function ownerKey(agentId: string): string {
  if (!agentId.trim()) {
    throw new Error("Agent work admission requires an agent owner.");
  }
  return normalizeAgentId(agentId);
}

function releaseToken(
  agentId: string,
  state: AgentWorkState,
  token: AgentWorkToken | NonNullable<AgentWorkState["mutation"]>,
): void {
  if ("execution" in token) {
    state.admissions.delete(token);
  }
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
export function beginAgentWorkAdmission(agentId: string): AgentWorkAdmission {
  return beginAgentWork(agentId, false);
}

function beginAgentWork(agentId: string, execution: boolean): AgentWorkAdmission {
  const key = ownerKey(agentId);
  const state: AgentWorkState = states.get(key) ?? { admissions: new Set() };
  if (state.mutation) {
    throw (
      state.mutation.createBusyError?.() ??
      new Error(`Agent "${key}" is changing its execution environment. Retry when it completes.`)
    );
  }
  const token = { execution };
  state.admissions.add(token);
  states.set(key, state);
  return Object.assign(() => releaseToken(key, state, token), {
    run<T>(run: () => T): T {
      // An execution may start another run. Its originating turn is a
      // competing owner, even if the new invocation inherits async context.
      const claims = [...(currentAdmissions.getStore() ?? [])].filter(
        (claim) => !execution || !claim.execution,
      );
      return currentAdmissions.run(new Set([...claims, token]), run);
    },
  });
}

/** Carries only the submitting turn's work claims across a scheduler handoff. */
export function bindAgentWorkAdmissionContext<T>(run: () => T): () => T {
  const admissions = currentAdmissions.getStore();
  return () => currentAdmissions.run(admissions, run);
}

export function runWithAgentWorkAdmissions<T>(
  admissions: Iterable<AgentWorkAdmission>,
  run: () => T,
): T {
  return Array.from(admissions).reduceRight((next, owner) => () => owner.run(next), run)();
}

export async function withAgentWorkAdmission<T>(
  agentId: string,
  run: () => Promise<T>,
): Promise<T> {
  const release = beginAgentWork(agentId, true);
  try {
    return await release.run(run);
  } finally {
    release();
  }
}

export function hasPendingAgentWork(agentId: string): boolean {
  return Boolean(states.get(ownerKey(agentId))?.admissions.size);
}

/** An in-band mutation may exclude only its own already admitted turn. */
export function tryAcquireAgentWorkMutation(
  agentId: string,
  options?: { allowCurrent?: boolean; createBusyError?: () => Error },
): (() => void) | null {
  const key = ownerKey(agentId);
  const state: AgentWorkState = states.get(key) ?? { admissions: new Set() };
  const current = options?.allowCurrent ? currentAdmissions.getStore() : undefined;
  if (state.mutation || [...state.admissions].some((admission) => !current?.has(admission))) {
    return null;
  }
  const token = options?.createBusyError ? { createBusyError: options.createBusyError } : {};
  state.mutation = token;
  states.set(key, state);
  return () => releaseToken(key, state, token);
}
