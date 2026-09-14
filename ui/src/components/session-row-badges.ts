import { html, nothing, type TemplateResult } from "lit";
// Deep import on purpose: the protocol barrel carries typebox and every
// schema, which must stay out of the Control UI startup bundle.
import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { GatewayAgentRuntime, GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { isSubagentSessionKey, parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { icons } from "./icons.ts";
import { renderProviderBrandIcon } from "./provider-icon.ts";

export type SessionPlacementState = NonNullable<GatewaySessionRow["placement"]>["state"];

export { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";

export function isStoppableCloudWorkerPlacement(
  placement: GatewaySessionRow["placement"],
): boolean {
  return placement?.state === "active";
}

function pullRequestStateLabel(state: SessionCatalogPullRequestSummary["state"]): string {
  switch (state) {
    case "open":
      return t("chat.pullRequests.open");
    case "draft":
      return t("chat.pullRequests.draft");
    case "merged":
      return t("chat.pullRequests.merged");
    case "closed":
      return t("chat.pullRequests.closed");
    default:
      return state satisfies never;
  }
}

function formatSessionPullRequestSummary(summary: SessionCatalogPullRequestSummary): string {
  const numbers = summary.numbers.map((number) => `#${number}`).join(", ");
  return `${numbers} · ${pullRequestStateLabel(summary.state)}`;
}

const ACP_HARNESS_LABELS = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
} as const;

type AcpHarnessAgent = keyof typeof ACP_HARNESS_LABELS;

function resolveAcpHarnessAgent(runtime: GatewayAgentRuntime | undefined): AcpHarnessAgent | null {
  if (runtime?.kind !== "acp") {
    return null;
  }
  const agent = runtime.agent?.trim().toLowerCase();
  return agent && agent in ACP_HARNESS_LABELS ? (agent as AcpHarnessAgent) : null;
}

function renderSessionRowBadge(
  label: string,
  icon: TemplateResult,
  modifier?: string,
  count?: number,
  pullRequestState?: SessionCatalogPullRequestSummary["state"],
  placementState?: SessionPlacementState,
  workspaceConflictCount?: number,
  acpAgent?: string,
) {
  return html`<openclaw-tooltip .content=${label}>
    <span
      class=${`session-row-badge${modifier ? ` ${modifier}` : ""}`}
      data-pull-request-state=${pullRequestState ?? nothing}
      data-placement-state=${placementState ?? nothing}
      data-workspace-conflicts=${workspaceConflictCount || nothing}
      data-acp-agent=${acpAgent ?? nothing}
      role="img"
      aria-label=${label}
      >${icon}${count ? html`<span aria-hidden="true">${count}</span>` : nothing}</span
    >
  </openclaw-tooltip>`;
}

export function renderSessionRowBadges(params: {
  key?: string;
  agentRuntime?: GatewayAgentRuntime;
  spawnedBy?: string;
  spawnDepth?: number;
  isChild?: boolean;
  incognito?: boolean;
  hasAutomation: boolean;
  pullRequest?: SessionCatalogPullRequestSummary;
  hasApproval?: boolean;
  outboxCount?: number;
  placementState?: SessionPlacementState;
  workspaceConflictCount?: number;
}) {
  // isChild is tree placement, not session type: promoted rows keep their badge.
  // Dashboard is a surface, not a runtime alternative to subagent/ACP.
  // parentSessionKey alone also describes operator forks and ordinary threading.
  const typeBadge = isSubagentSessionKey(params.key)
    ? renderSessionRowBadge(
        t("sessionsView.subagentType"),
        icons.bot,
        "session-row-badge--subagent",
      )
    : parseAgentSessionKey(params.key)?.rest.startsWith("dashboard:") &&
        Number.isInteger(params.spawnDepth) &&
        params.spawnDepth! > 0 &&
        params.spawnedBy?.trim()
      ? renderSessionRowBadge(
          t("sessionsView.dashboardTaskType"),
          icons.layoutDashboard,
          "session-row-badge--dashboard-task",
        )
      : null;
  const acpHarnessAgent = resolveAcpHarnessAgent(params.agentRuntime);
  const acpHarnessBadge = acpHarnessAgent
    ? renderSessionRowBadge(
        ACP_HARNESS_LABELS[acpHarnessAgent],
        renderProviderBrandIcon(acpHarnessAgent, {
          className: "session-row-badge__provider-icon",
        }),
        `session-row-badge--acp session-row-badge--acp-${acpHarnessAgent}`,
        0,
        undefined,
        undefined,
        undefined,
        acpHarnessAgent,
      )
    : null;
  const hasAutomation = !params.isChild && params.hasAutomation;
  const pullRequestLabel = params.pullRequest
    ? formatSessionPullRequestSummary(params.pullRequest)
    : undefined;
  const workspaceConflictCount = Math.max(0, Math.floor(params.workspaceConflictCount ?? 0));
  // Child rows suppress ordinary placement chrome, but a retained conflict must stay discoverable.
  const displayedPlacementState =
    (!params.isChild && isCloudWorkerPlacementState(params.placementState)) ||
    workspaceConflictCount
      ? params.placementState
      : undefined;
  const outboxCount = Math.max(0, Math.floor(params.outboxCount ?? 0));
  if (
    !typeBadge &&
    !acpHarnessBadge &&
    !params.incognito &&
    !hasAutomation &&
    !pullRequestLabel &&
    !params.hasApproval &&
    !outboxCount &&
    !displayedPlacementState &&
    !workspaceConflictCount
  ) {
    return nothing;
  }
  const cloudLabel = workspaceConflictCount
    ? displayedPlacementState
      ? t(
          workspaceConflictCount === 1
            ? "sessionsView.cloudWorkerPlacementConflict"
            : "sessionsView.cloudWorkerPlacementConflicts",
          {
            state: displayedPlacementState,
            count: String(workspaceConflictCount),
          },
        )
      : t(
          workspaceConflictCount === 1
            ? "sessionsView.cloudWorkerDescendantConflict"
            : "sessionsView.cloudWorkerDescendantConflicts",
          { count: String(workspaceConflictCount) },
        )
    : displayedPlacementState
      ? t("sessionsView.cloudWorkerPlacement", { state: displayedPlacementState })
      : "";
  return html`<span class="session-row-badges">
    ${typeBadge} ${acpHarnessBadge}
    ${params.incognito
      ? renderSessionRowBadge(
          t("sessionsView.incognito"),
          icons.lock,
          "session-row-badge--incognito",
        )
      : nothing}
    ${hasAutomation
      ? renderSessionRowBadge(t("sessionsView.automationAttached"), icons.clock)
      : nothing}
    ${pullRequestLabel
      ? renderSessionRowBadge(
          pullRequestLabel,
          icons.gitPullRequest,
          "session-row-badge--pull-request",
          0,
          params.pullRequest?.state,
        )
      : nothing}
    ${params.hasApproval
      ? renderSessionRowBadge(
          t("sessionsView.approvalNeeded"),
          icons.alertTriangle,
          "session-row-badge--approval",
        )
      : nothing}
    ${outboxCount
      ? renderSessionRowBadge(
          t(outboxCount === 1 ? "sessionsView.queuedMessage" : "sessionsView.queuedMessages", {
            count: String(outboxCount),
          }),
          icons.clock,
          "session-row-badge--queued",
          outboxCount,
        )
      : nothing}
    ${displayedPlacementState || workspaceConflictCount
      ? renderSessionRowBadge(
          cloudLabel,
          icons.globe,
          "session-row-badge--cloud",
          0,
          undefined,
          displayedPlacementState,
          workspaceConflictCount,
        )
      : nothing}
  </span>`;
}

export function renderOfflineSidebarStatus(props: {
  queuedOutboxCount: number;
  reconnecting: string;
  title?: string;
  onRetry: () => void;
}) {
  const offline = t("common.offline");
  const count = props.queuedOutboxCount;
  const queued = count ? t("connection.queuedCount", { count: String(count) }) : null;
  return html`<openclaw-tooltip .content=${props.title ?? ""}>
    <button
      type="button"
      class="sidebar-footer-bar__status"
      aria-live="polite"
      aria-label=${`${offline} — ${t("connection.retryNow")}${queued ? ` — ${queued}` : ""}`}
      @click=${props.onRetry}
    >
      <span class="sidebar-footer-bar__status-dot" aria-hidden="true"></span>${offline}<span
        class="sidebar-footer-bar__status-detail"
        >· ${props.reconnecting}</span
      >${queued
        ? html`<span class="sidebar-footer-bar__status-detail">· ${queued}</span>`
        : nothing}
    </button>
  </openclaw-tooltip>`;
}
