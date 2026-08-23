import type { AgentsListResult } from "../../api/types.ts";
import { pathForMemoryTab } from "../../app-route-paths.ts";
import type { AgentSelectOption } from "../../components/agent-select.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../../lib/agents/display.ts";
import type { MemoryTab } from "./memory-schema.ts";
import type { ConfigRouteData } from "./route-data.ts";

export type MemoryRouteAgentResolution = {
  agentId: string | null;
  invalidSource?: string;
  normalizedSearch?: string;
};

export function resolveMemoryRouteAgent(
  routeData: ConfigRouteData | null,
  agentsList: AgentsListResult | null,
): MemoryRouteAgentResolution | null {
  if (!routeData) {
    return null;
  }
  const params = new URLSearchParams(routeData.search);
  const requestedAgentId = params.get("agent");
  if (!requestedAgentId) {
    return null;
  }
  if (!agentsList) {
    return { agentId: requestedAgentId };
  }
  const selectable = listSelectableAgents(agentsList.agents);
  if (selectable.some((agent) => agent.id === requestedAgentId)) {
    return { agentId: requestedAgentId };
  }
  params.delete("agent");
  const search = params.toString();
  return {
    agentId: agentsList.defaultId ?? selectable[0]?.id ?? null,
    invalidSource: `${routeData.pathname}${routeData.search}${routeData.hash}`,
    normalizedSearch: search ? `?${search}` : "",
  };
}

export function resolveMemoryAgentId(
  agentsList: AgentsListResult | null,
  selectedAgentId: string | null,
): string | null {
  const selectable = listSelectableAgents(agentsList?.agents ?? []);
  return selectedAgentId && selectable.some((agent) => agent.id === selectedAgentId)
    ? selectedAgentId
    : (agentsList?.defaultId ?? selectable[0]?.id ?? null);
}

export function buildMemoryAgentOptions(agentsList: AgentsListResult | null): AgentSelectOption[] {
  return listSelectableAgents(agentsList?.agents ?? []).map((agent) => ({
    value: agent.id,
    label: normalizeAgentLabel(agent),
    agent,
  }));
}

export function memoryTabRouteLocation(
  tab: MemoryTab,
  agentId: string | null,
  fallbackSearch: string | undefined,
  basePath: string,
) {
  const search = agentId ? `?agent=${encodeURIComponent(agentId)}` : fallbackSearch;
  return { pathname: pathForMemoryTab(tab, basePath), ...(search ? { search } : {}) };
}
