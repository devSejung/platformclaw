import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";

type GatewaySnapshot = ApplicationContext["gateway"]["snapshot"];

export function buildMemoryTabContent(snapshot: GatewaySnapshot, agentId: string | null) {
  return {
    memories: html`<openclaw-memory-memories
      .client=${snapshot.client}
      .connected=${snapshot.phase === "connected"}
      .connectionPhase=${snapshot.phase}
      .methodAdvertised=${isGatewayMethodAdvertised(snapshot, "memory.search")}
      .personalDetailAdvertised=${isGatewayMethodAdvertised(snapshot, "agents.workspace.get")}
      .agentId=${agentId}
    ></openclaw-memory-memories>`,
    wiki: html`<openclaw-agent-memory-panel
      .agentId=${agentId ?? ""}
      surface="wiki"
    ></openclaw-agent-memory-panel>`,
    dreams: html`<openclaw-memory-dreaming .agentId=${agentId}></openclaw-memory-dreaming>`,
  };
}
