import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusReport } from "../../api/types.ts";

function skillsAgentParams(
  agentId: string | null | undefined,
  refresh = false,
): { agentId?: string; refresh?: boolean } {
  const normalized = agentId?.trim();
  return {
    ...(normalized ? { agentId: normalized } : {}),
    ...(refresh ? { refresh: true } : {}),
  };
}

export async function loadSkillStatusReport(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  refresh = false,
): Promise<SkillStatusReport | undefined> {
  return client.request<SkillStatusReport | undefined>(
    "skills.status",
    skillsAgentParams(agentId, refresh),
  );
}
