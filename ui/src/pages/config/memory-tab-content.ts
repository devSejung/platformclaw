import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";

type GatewaySnapshot = ApplicationContext["gateway"]["snapshot"];

export function buildMemoryTabContent(snapshot: GatewaySnapshot, agentId: string | null) {
  return {
    memories: html`<openclaw-memory-memories
      .client=${snapshot.client}
      .connected=${snapshot.phase === "connected"}
      .methodAdvertised=${isGatewayMethodAdvertised(snapshot, "memory.search") === true}
      .agentId=${agentId}
    ></openclaw-memory-memories>`,
    wiki: html`<openclaw-agent-memory-panel
      .agentId=${agentId ?? ""}
      surface="wiki"
    ></openclaw-agent-memory-panel>`,
    organization: html`<openclaw-memory-promotions
      .client=${snapshot.client}
      .connected=${snapshot.phase === "connected"}
      .methodAdvertised=${isGatewayMethodAdvertised(snapshot, "platformclaw.memory.lifecycle") ===
      true}
      .wikiSearchAdvertised=${isGatewayMethodAdvertised(snapshot, "wiki.search") === true}
      .wikiGetAdvertised=${isGatewayMethodAdvertised(snapshot, "wiki.get") === true}
      .agentId=${agentId}
    ></openclaw-memory-promotions>`,
    dreams: html`<openclaw-memory-dreaming .agentId=${agentId}></openclaw-memory-dreaming>`,
  };
}
