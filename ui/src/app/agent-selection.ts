import type { GatewayBrowserClient } from "../api/gateway.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";

type AgentSelectionGateway = {
  readonly snapshot: {
    client: GatewayBrowserClient | null;
    assistantAgentId: string | null;
  };
  subscribe: (listener: (snapshot: AgentSelectionGateway["snapshot"]) => void) => () => void;
};

type AgentSelectionState = {
  selectedId: string | null;
  /** Agent filter shared by agent-owned pages; null exposes all agents. */
  scopeId: string | null;
};

export type AgentSelectionCapability = {
  readonly state: AgentSelectionState;
  set: (agentId: string | null) => void;
  setScope: (agentId: string | null) => void;
  subscribe: (listener: (state: AgentSelectionState) => void) => () => void;
};

export function createAgentSelectionCapability(
  gateway: AgentSelectionGateway,
): AgentSelectionCapability {
  const initialId = gateway.snapshot.assistantAgentId
    ? normalizeAgentId(gateway.snapshot.assistantAgentId)
    : null;
  let state: AgentSelectionState = { selectedId: initialId, scopeId: initialId };
  let client = gateway.snapshot.client;
  let assistantAgentId = initialId;
  let selectedExplicitly = false;
  let scopeExplicitly = false;
  const listeners = new Set<(next: AgentSelectionState) => void>();

  const publish = (next: AgentSelectionState) => {
    if (state.selectedId === next.selectedId && state.scopeId === next.scopeId) {
      return;
    }
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  };

  gateway.subscribe((next) => {
    const nextAssistantAgentId = next.assistantAgentId
      ? normalizeAgentId(next.assistantAgentId)
      : null;
    if (next.client !== client) {
      client = next.client;
      assistantAgentId = nextAssistantAgentId;
      selectedExplicitly = false;
      scopeExplicitly = false;
      publish({ selectedId: nextAssistantAgentId, scopeId: nextAssistantAgentId });
      return;
    }
    if (nextAssistantAgentId !== assistantAgentId) {
      const previousAssistantAgentId = assistantAgentId;
      assistantAgentId = nextAssistantAgentId;
      // The client exists before hello supplies its real default agent. Adopt that
      // identity without clobbering a route or scope the user already selected.
      publish({
        selectedId:
          !selectedExplicitly &&
          (state.selectedId === null || state.selectedId === previousAssistantAgentId)
            ? nextAssistantAgentId
            : state.selectedId,
        scopeId:
          !scopeExplicitly && (state.scopeId === null || state.scopeId === previousAssistantAgentId)
            ? nextAssistantAgentId
            : state.scopeId,
      });
    }
  });

  return {
    get state() {
      return state;
    },
    set(agentId) {
      const selectedId = agentId?.trim() ? normalizeAgentId(agentId) : null;
      // A chip/chat switch establishes a new global page scope. The separate
      // scope field lets page controls expose all agents without losing the
      // concrete agent required by chat and new-session flows.
      selectedExplicitly = true;
      scopeExplicitly = true;
      publish({ selectedId, scopeId: selectedId });
    },
    setScope(agentId) {
      const scopeId = agentId?.trim() ? normalizeAgentId(agentId) : null;
      scopeExplicitly = true;
      publish({ ...state, scopeId });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
