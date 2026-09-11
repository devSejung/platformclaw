import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../../app/context.ts";
import { formatTimeMs } from "../../../lib/format.ts";
import { createDreamingState, type DreamingState } from "./dreaming.ts";
import { wikiDraftDirty, type DreamingViewState } from "./view.ts";

export type DreamingTaskScope = {
  gateway: ApplicationGateway;
  epoch: number;
  state: DreamingState;
};

export function preventDirtyWikiUnload(event: BeforeUnloadEvent, state: DreamingViewState): void {
  if (wikiDraftDirty(state)) {
    event.preventDefault();
    event.returnValue = "";
  }
}

export function resolveDreamingNextCycle(status: DreamingState["dreamingStatus"]): string | null {
  const nextRunAtMs = Object.values(status?.phases ?? {})
    .filter((phase) => phase.enabled && typeof phase.nextRunAtMs === "number")
    .map((phase) => phase.nextRunAtMs as number)
    .toSorted((a, b) => a - b)[0];
  return nextRunAtMs === undefined
    ? null
    : formatTimeMs(nextRunAtMs, { hour: "numeric", minute: "2-digit" }, "") || null;
}

export function createMemoryPanelGatewayState(
  context: ApplicationContext,
  agentId: string,
  snapshot: ApplicationGatewaySnapshot = context.gateway.snapshot,
): DreamingState {
  return createDreamingState({
    client: snapshot.client,
    connected: snapshot.phase === "connected",
    hello: snapshot.hello,
    configSnapshot: context.runtimeConfig.state.configSnapshot,
    applySessionKey: snapshot.sessionKey,
    selectedAgentId: agentId.trim() || null,
  });
}
