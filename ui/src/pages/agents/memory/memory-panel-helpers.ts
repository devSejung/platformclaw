import { html } from "lit";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../../app/context.ts";
import { renderSettingsRow } from "../../../components/settings-ui.ts";
import { t } from "../../../i18n/index.ts";
import { formatDateTimeMs } from "../../../lib/format.ts";
import { createDreamingState, type DreamingState } from "./dreaming.ts";
import {
  wikiDocumentT,
  wikiDraftDirty,
  type DreamingViewState,
  type renderDreaming,
} from "./view.ts";

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

function resolveDreamingNextCycle(status: DreamingState["dreamingStatus"]): string | null {
  const nextRunAtMs = Object.values(status?.phases ?? {})
    .filter((phase) => phase.enabled && typeof phase.nextRunAtMs === "number")
    .map((phase) => phase.nextRunAtMs as number)
    .toSorted((a, b) => a - b)[0];
  return nextRunAtMs === undefined
    ? null
    : formatDateTimeMs(
        nextRunAtMs,
        status?.timezone ? { timeZone: status.timezone } : undefined,
        "",
      ) || null;
}

type DreamingStatusViewProps = Pick<
  Parameters<typeof renderDreaming>[0],
  | "active"
  | "statusLoading"
  | "statusAvailable"
  | "selectedAgentId"
  | "shortTermCount"
  | "promotedCount"
  | "promotedTotal"
  | "lastPromotedAt"
  | "phases"
  | "shortTermEntries"
  | "promotedEntries"
  | "nextCycle"
  | "timezone"
  | "statusError"
>;

export function dreamingStatusViewProps(params: {
  dreaming: DreamingState;
  status: DreamingState["dreamingStatus"];
  active: boolean;
  selectedAgentId: string;
}): DreamingStatusViewProps {
  const { dreaming, status } = params;
  return {
    active: params.active,
    statusLoading: dreaming.dreamingStatusLoading,
    statusAvailable: status !== null,
    selectedAgentId: params.selectedAgentId,
    shortTermCount: status?.shortTermCount ?? 0,
    promotedCount: status?.promotedToday ?? 0,
    promotedTotal: status?.promotedTotal ?? 0,
    lastPromotedAt: status?.lastPromotedAt ?? null,
    phases: status?.phases ?? undefined,
    shortTermEntries: status?.shortTermEntries ?? [],
    promotedEntries: status?.promotedEntries ?? [],
    nextCycle: resolveDreamingNextCycle(status),
    timezone: status?.timezone ?? null,
    statusError: dreaming.dreamingStatusError,
  };
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

export function renderMemoryPanelSummary(params: {
  dreaming: DreamingState;
  dreamingStatus: DreamingState["dreamingStatus"];
  dreamingOn: boolean;
  refreshLoading: boolean;
  onRefresh: () => void;
}) {
  const known = params.dreamingStatus !== null && !params.dreaming.dreamingStatusError;
  const unavailable = wikiDocumentT("dreaming.summary.unavailable");
  const statusTitle = wikiDocumentT(
    params.dreaming.dreamingStatusError
      ? "dreaming.summary.statusUnavailable"
      : params.dreamingOn
        ? "dreaming.summary.enabled"
        : "dreaming.summary.disabled",
  );
  const statusDescription =
    params.dreaming.dreamingStatusError ??
    (params.dreaming.dreamingStatusLoading
      ? wikiDocumentT("dreaming.summary.loading")
      : !known
        ? wikiDocumentT("dreaming.summary.statusUnavailable")
        : undefined);
  return html`<section class="settings-group agent-memory-panel__summary">
    ${renderSettingsRow({
      title: statusTitle,
      description: statusDescription,
      control: html`<button
        class="btn btn--sm"
        ?disabled=${params.refreshLoading}
        @click=${params.onRefresh}
      >
        ${params.refreshLoading
          ? t("dreaming.header.refreshing")
          : t("memoryPage.overview.hero.refresh")}
      </button>`,
    })}
    ${renderSettingsRow({
      title: t("memoryPage.overview.activity.shortTermCount"),
      control: html`<span class="settings-row__value"
        >${known ? params.dreamingStatus!.shortTermCount : unavailable}</span
      >`,
    })}
    ${renderSettingsRow({
      title: t("memoryPage.overview.activity.promotedToday"),
      control: html`<span class="settings-row__value"
        >${known ? params.dreamingStatus!.promotedToday : unavailable}</span
      >`,
    })}
  </section>`;
}
