// Keep UI validation on the same parser as BFF/RPC so provider and quote rules cannot drift.
import {
  parseCodingAgentConfiguration,
  type CodingAgentId,
  type CodingAgentConfiguration,
  type CodingAgentProbeResult,
  type PersonalCodingAgentSettings,
} from "@platformclaw/coding-agent-contract";
import { platformClawT as t } from "./i18n.ts";

export type ExecutionTarget = "platform_server" | "assigned_vm";
export type SavedVmConnection = {
  id: string;
  vmHostId: string;
  vmLabel: string;
  safeConnectLabel: string;
  linuxAccount: string;
  status: "ready" | "connection_required" | "unavailable";
  active: boolean;
  remoteWorkspaceDir?: string;
  lastConnectionSucceededAt?: number;
};
export type ExecutionLocation = { target: ExecutionTarget; label?: string; connectionId?: string };
export type ExecutionTransition = { from: ExecutionLocation; to: ExecutionLocation };
export type ExecutionSettings = {
  activeTarget: ExecutionTarget;
  targetRevision: number;
  credentialStatus: "missing" | "current" | "update_required";
  accountId: string;
  availableVms: Array<{ id: string; label: string }>;
  savedVms: SavedVmConnection[];
  assignment?: {
    id: string;
    vmHostId: string;
    status: "assigned" | "ready" | "connection_required" | "revoked";
    vmLabel: string;
    safeConnectLabel: string;
    linuxAccount: string;
    remoteWorkspaceDir?: string;
    lastConnectionSucceededAt?: number;
  };
  codingAgents: PersonalCodingAgentSettings[];
};

export type ClaudeEnvironmentKey =
  | "ANTHROPIC_BASE_URL"
  | "ADMIN_API_URL"
  | "OIDC_ISSUER_URL"
  | "OIDC_CLIENT_ID";

export const AGENT_LABELS: Record<CodingAgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const DEFAULT_EXECUTABLES: Record<CodingAgentId, string> = {
  claude: "/home/me/.local/bin/claude",
  codex: "/usr/local/bin/codex",
  opencode: "/usr/local/bin/opencode",
};

export const CLAUDE_ENVIRONMENT: Array<{ key: ClaudeEnvironmentKey; labelKey: string }> = [
  { key: "ANTHROPIC_BASE_URL", labelKey: "platformClaw.execution.anthropicBaseUrl" },
  { key: "ADMIN_API_URL", labelKey: "platformClaw.execution.adminApiUrl" },
  { key: "OIDC_ISSUER_URL", labelKey: "platformClaw.execution.oidcIssuerUrl" },
  { key: "OIDC_CLIENT_ID", labelKey: "platformClaw.execution.oidcClientId" },
];

function localizedRequestError(value: unknown, fallbackKey: string): string {
  if (value === "AD password was not accepted") {
    return t("platformClaw.execution.passwordRejected");
  }
  return typeof value === "string" ? value : t(fallbackKey);
}

export class ExecutionRequestError extends Error {
  constructor(
    readonly value: unknown,
    readonly fallbackKey: string,
  ) {
    super(localizedRequestError(value, fallbackKey));
  }
}

export function executionErrorMessage(error: unknown): string {
  return error instanceof ExecutionRequestError
    ? localizedRequestError(error.value, error.fallbackKey)
    : error instanceof Error
      ? error.message
      : t("platformClaw.execution.requestFailed");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    if (character === "&") {
      return "&amp;";
    }
    if (character === "<") {
      return "&lt;";
    }
    if (character === ">") {
      return "&gt;";
    }
    if (character === "'") {
      return "&#39;";
    }
    return "&quot;";
  });
}

export function formatCheckTime(value?: number): string {
  if (!value) {
    return t("platformClaw.execution.neverChecked");
  }
  const date = new Date(value);
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}

export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function hasLiteralSurroundingQuotes(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  );
}

export type ExecutionAction = "selection" | "credential" | "test" | "release";
// Keep outcome facts until rendering so an in-flight or completed action follows locale changes.
export type ExecutionActivity = (
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "switching"; target: ExecutionTarget; connected: boolean }
  | { kind: "working"; action: Exclude<ExecutionAction, "selection"> }
  | {
      kind: "success";
      offerActivation?: boolean;
      action: ExecutionAction | ExecutionTarget;
      target: ExecutionTarget | null;
      connection: "complete" | null;
    }
  | {
      kind: "error";
      action: ExecutionAction | ExecutionTarget;
      error: unknown;
      locationUnknown: boolean;
      target: ExecutionTarget | null;
      connection: "complete" | "failed" | null;
    }
) & { transition?: ExecutionTransition };

// A successful credential request is the receipt. Reconciled ready/current state alone
// cannot prove that the submitted password was accepted or authorize a location change.
export function isCredentialProgress(activity: ExecutionActivity): boolean {
  return activity.kind === "working"
    ? activity.action === "credential"
    : (activity.kind === "success" || activity.kind === "error") &&
        activity.action === "credential";
}

export function hasExecutionProgress(activity: ExecutionActivity): boolean {
  return (
    isCredentialProgress(activity) ||
    activity.kind === "connecting" ||
    activity.kind === "switching" ||
    ((activity.kind === "success" || activity.kind === "error") && activity.target !== null)
  );
}

export function canActivateVerifiedVm(
  settings: ExecutionSettings | null,
  activity: ExecutionActivity,
): boolean {
  return (
    activity.kind === "success" &&
    activity.action === "credential" &&
    activity.target === null &&
    activity.offerActivation === true &&
    settings?.activeTarget === "platform_server" &&
    settings.assignment?.status === "ready" &&
    settings.credentialStatus === "current"
  );
}

export function completedExecutionActivity(
  settings: ExecutionSettings,
  action: ExecutionAction | ExecutionTarget,
  connected: boolean,
): ExecutionActivity {
  return {
    kind: "success",
    action,
    connection: connected ? "complete" : null,
    target:
      action === "selection" || action === "assigned_vm" || action === "platform_server"
        ? settings.activeTarget
        : null,
    offerActivation:
      action === "credential" &&
      settings.activeTarget === "platform_server" &&
      settings.assignment?.status === "ready" &&
      settings.credentialStatus === "current",
  };
}

export function canRetryExecutionProgress(
  settings: ExecutionSettings | null,
  activity: ExecutionActivity,
): boolean {
  return (
    activity.kind === "error" &&
    activity.target !== null &&
    activity.connection !== "failed" &&
    settings !== null &&
    (activity.target === "platform_server" ||
      (activity.transition?.to.connectionId
        ? settings.savedVms.some(
            (vm) => vm.id === activity.transition?.to.connectionId && vm.status === "ready",
          )
        : settings?.assignment?.status === "ready" && settings.credentialStatus === "current"))
  );
}

export type VmSelectionDraft = { vmHostId: string; linuxAccount: string };

const executionProgressStyles = `
  .badge[aria-busy="true"] .dot{width:12px;height:12px;box-sizing:border-box;border:2px solid var(--border);border-top-color:var(--run);background:transparent;animation:execution-spin 1s linear infinite}
  .message.message--success{border-inline-start:3px solid var(--ok);background:var(--bg);color:var(--text)}
  .message.message--error{border-inline-start:3px solid var(--danger);background:var(--bg)}
  .progress{display:grid;gap:12px;list-style:none;margin:0;padding:14px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--card)}
  .progress li{display:flex;gap:10px;align-items:center;color:var(--muted)}
  .progress [data-state="active"]{color:var(--text);font-weight:600}
  .step-dot{width:14px;height:14px;box-sizing:border-box;flex:none;border:2px solid var(--border-strong);border-radius:50%}
  [data-state="active"] .step-dot{border-color:var(--border);border-top-color:var(--run);animation:execution-spin 1s linear infinite}
  [data-state="complete"] .step-dot{background:var(--ok);border-color:var(--ok)}
  [data-state="failed"] .step-dot{background:var(--danger);border-color:var(--danger)}
  @keyframes execution-spin{to{transform:rotate(360deg)}}
  @media(prefers-reduced-motion:reduce){.dot,.step-dot{animation:none!important}}
`;

function executionCodingAgentSummary(saved?: PersonalCodingAgentSettings): string {
  if (!saved?.lastCheck) {
    return t("platformClaw.execution.agentSummaryNotChecked");
  }
  if (saved.lastCheck.diagnostics.some((diagnostic) => diagnostic.status === "failed")) {
    return t("platformClaw.execution.agentSummaryAttention");
  }
  const acp = saved.lastCheck.diagnostics.find((diagnostic) => diagnostic.stage === "acp");
  if (acp?.status === "passed") {
    return t("platformClaw.execution.agentSummaryReady");
  }
  const executable = saved.lastCheck.diagnostics.find(
    (diagnostic) => diagnostic.stage === "executable",
  );
  return executable?.status === "passed"
    ? t("platformClaw.execution.agentSummaryInstalled")
    : t("platformClaw.execution.agentSummaryNotChecked");
}

export function renderExecutionTabs(activeTab: "location" | "agents"): string {
  return `<wa-tab-group class="settings-tabs" aria-label="${escapeHtml(t("platformClaw.execution.settingsSections"))}" active="${activeTab}" activation="manual" without-scroll-controls>${(
    ["location", "agents"] as const
  )
    .map((id) => {
      const selected = activeTab === id;
      return `<wa-tab id="execution-tab-${id}" slot="nav" panel="${id}" data-settings-tab="${id}" ${selected ? "active" : ""}>${escapeHtml(t(id === "location" ? "platformClaw.execution.locationTab" : "platformClaw.execution.agentsTab"))}</wa-tab>`;
    })
    .join("")}</wa-tab-group>`;
}

function renderExecutionDiagnostics(
  result: CodingAgentProbeResult | PersonalCodingAgentSettings["lastCheck"],
  needsRecheck: boolean,
  preview: boolean,
  probeTime?: number,
): string {
  if (!result) {
    return `<p class="status-copy muted">${escapeHtml(t("platformClaw.execution.agentNotChecked"))}</p>`;
  }
  const diagnostics = result.diagnostics
    .map(
      (diagnostic) =>
        `<li class="diagnostic diagnostic--${diagnostic.status}"><span aria-hidden="true">${diagnostic.status === "passed" ? "✓" : diagnostic.status === "failed" ? "!" : "–"}</span><span><strong>${escapeHtml(t(diagnostic.stage === "executable" ? "platformClaw.execution.agentStageInstalled" : diagnostic.stage === "helper" ? "platformClaw.execution.agentStageAuthentication" : "platformClaw.execution.agentStageAcpConnection"))}</strong><small>${escapeHtml(diagnostic.message)}</small></span></li>`,
    )
    .join("");
  const checkedAt = "checkedAt" in result ? result.checkedAt : probeTime;
  return `<div class="agent-status">${preview ? `<p class="stale-status">${escapeHtml(t("platformClaw.execution.agentDetectedPreview"))}</p>` : ""}${needsRecheck ? `<p class="stale-status">${escapeHtml(t("platformClaw.execution.agentNeedsRecheck"))}</p>` : ""}<ul class="${needsRecheck ? "is-stale" : ""}">${diagnostics}</ul>${result.reportedVersion ? `<p class="version">${escapeHtml(result.reportedVersion)}${checkedAt ? ` · ${escapeHtml(formatCheckTime(checkedAt))}` : ""}</p>` : ""}</div>`;
}

function executionTargetLabel(target: ExecutionTarget): string {
  return t(target === "assigned_vm" ? "platformClaw.execution.vm" : "platformClaw.execution.basic");
}

function executionBusyMessage(activity: ExecutionActivity): string {
  return activity.kind === "connecting"
    ? t("platformClaw.execution.connecting")
    : activity.kind === "switching"
      ? t("platformClaw.execution.switching", {
          target: activity.transition?.to.label ?? executionTargetLabel(activity.target),
        })
      : activity.kind === "working"
        ? t(
            activity.action === "release"
              ? "platformClaw.execution.releasing"
              : "platformClaw.execution.testing",
          )
        : "";
}

export function renderExecutionSettingsStyles(warn: boolean): string {
  return `<style>${executionProgressStyles}
      [hidden]{display:none!important}
      .panel{grid-template-rows:auto auto minmax(0,1fr) auto!important}.agent-card .disable-note{display:none}
      .settings-tabs{--track-width:0;--track-color:transparent;--indicator-color:transparent;display:block;padding:0 22px 10px;border-bottom:1px solid var(--border)}.settings-tabs::part(nav){display:block}.settings-tabs::part(tabs){display:flex;gap:4px;padding:4px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg)}.settings-tabs::part(body){display:none}.settings-tabs wa-tab{flex:1 1 0;min-width:0;border-radius:calc(var(--radius-md) - 2px);color:var(--muted);font-weight:550;transition:color .12s ease}.settings-tabs wa-tab::part(base){display:flex;align-items:center;justify-content:center;width:100%;padding:8px 10px;border-radius:inherit;color:inherit;font:inherit}.settings-tabs wa-tab:hover{color:var(--text)}.settings-tabs wa-tab:hover::part(base),.settings-tabs wa-tab[active]::part(base){background:var(--bg-hover)}.settings-tabs wa-tab[active]{color:var(--text-strong);font-weight:700}.settings-tabs wa-tab:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 22%,transparent);border-radius:var(--radius-sm)}.settings-tabs wa-tab:focus-visible::part(base){outline:none}.tab-panel{display:grid;gap:14px}.agent-context,.agent-shared-help{margin:0;color:var(--muted)}.agent-context{font-weight:700;color:var(--text)}.agent-card.is-collapsed>.agent-settings{display:none}.agent-settings{display:grid;gap:12px}.compact-check{margin-top:4px!important}.agent-quick-save{margin-top:7px;padding:5px 8px;font-size:12px}.agent-progress{margin:0;padding:8px 10px;border-radius:var(--radius-md);background:var(--accent-subtle);font-weight:700}.agent-expand{border:0;background:transparent;color:var(--accent);padding:5px;cursor:pointer}.agent-expand:focus-visible{outline:none;box-shadow:var(--focus-ring)}
      .agent-status ul.is-stale{opacity:.5}.stale-status,.unsaved{margin:0 0 6px;color:var(--warn);font-size:12px}
      :host{display:block;color:var(--text);font:13px/1.45 var(--font-sans,system-ui,sans-serif)}button,input,select{font:inherit}*{box-sizing:border-box}.badge{display:flex;width:100%;min-height:34px;align-items:center;gap:8px;border:0;border-radius:var(--radius-md);padding:7px 9px;background:transparent;color:var(--text);cursor:pointer;text-align:left}.badge:hover,.badge:focus-visible{background:var(--bg-hover);outline:none}.dot{width:7px;height:7px;flex:none;border-radius:var(--radius-full);background:${warn ? "var(--warn)" : "var(--ok)"}}
      .modal{--openclaw-modal-width:min(680px,calc(100vw - 32px));--openclaw-modal-max-height:min(820px,calc(100dvh - 24px))}.panel{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:min(680px,100%);max-height:min(820px,calc(100dvh - 24px));overflow:hidden;border-radius:var(--radius-xl);background:var(--bg-elevated);color:var(--text);box-shadow:var(--shadow-xl);border:1px solid var(--border)}header{display:flex;justify-content:space-between;align-items:center;padding:20px 22px 12px}h2{margin:0;font-size:20px}h3{margin:0;font-size:15px}.close{border:0;background:transparent;color:inherit;font-size:22px;cursor:pointer}main{min-height:0;overflow:auto;scrollbar-gutter:stable;padding:8px 22px 22px;display:grid;gap:14px}footer{padding:14px 22px;border-top:1px solid var(--border);background:var(--bg-elevated)}footer h3,footer p{margin:0}footer p{margin-top:6px}footer .row{margin-top:12px}.card,.agent-card{padding:15px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--card)}
      .coding-agents{display:grid;gap:10px}.coding-agents>h3{margin-top:2px}.agent-card{display:grid;gap:12px}.agent-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.agent-heading p,.disable-note,.check-note{margin:3px 0 0;color:var(--muted);font-size:12px}.disable-note{margin-top:-7px}.check-note{margin:0}.switch{display:flex;align-items:center;gap:7px;cursor:pointer;white-space:nowrap}.switch input{position:absolute;opacity:0;pointer-events:none}.switch span{position:relative;width:34px;height:20px;border-radius:99px;background:var(--border-strong);transition:background .15s ease}.switch span::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:white;box-shadow:0 1px 3px #0005;transition:transform .15s ease}.switch input:checked+span{background:var(--accent)}.switch input:checked+span::after{transform:translateX(14px)}.switch input:focus-visible+span{box-shadow:var(--focus-ring)}.switch input:disabled~*{opacity:.5;cursor:not-allowed}.switch b{font-size:12px}
      .agent-status ul{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:0;padding:0;list-style:none}.diagnostic{display:flex;gap:7px;min-width:0;padding:8px;border-radius:var(--radius-md);background:var(--bg);border:1px solid var(--border)}.diagnostic>span:first-child{display:grid;place-items:center;width:18px;height:18px;flex:none;border-radius:50%;font-weight:700;background:var(--bg-hover)}.diagnostic--passed>span:first-child{color:var(--ok)}.diagnostic--failed>span:first-child{color:var(--danger)}.diagnostic strong,.diagnostic small{display:block;overflow:hidden;text-overflow:ellipsis}.diagnostic small{color:var(--muted);margin-top:2px}.version{margin:6px 0 0;color:var(--muted);font-size:12px}.field{display:grid;gap:5px}.field>span:first-child{font-weight:600}.field small{color:var(--muted);font-family:var(--font-mono,monospace);font-size:11px}input,select{width:100%;padding:9px 10px;border-radius:var(--radius-md);border:1px solid var(--border-strong);background:var(--bg);color:var(--text)}input:focus,select:focus{border-color:var(--accent);outline:none;box-shadow:var(--focus-ring)}input[aria-invalid=true]{border-color:var(--danger)}.field-error{color:var(--danger);font-size:12px}.field-error:empty{display:none}
      .gateway{border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden}.gateway summary{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;padding:10px 11px;background:var(--bg)}.gateway summary::-webkit-details-marker{display:none}.gateway summary span:first-child{display:grid}.gateway summary small{color:var(--muted)}.gateway[open] .chevron{transform:rotate(180deg)}.gateway-fields{display:grid;gap:10px;padding:12px;border-top:1px solid var(--border)}.field-help{margin:0;color:var(--muted)}.configuration-error{margin:0;color:var(--danger);font-size:12px}.muted{color:var(--muted);margin:4px 0}.row,.agent-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.agent-actions{padding-top:2px}.button{border:1px solid var(--border-strong);border-radius:var(--radius-md);padding:8px 11px;background:var(--bg-elevated);color:var(--text);cursor:pointer}.button:hover:not(:disabled),.button:focus-visible{border-color:var(--border-hover);background:var(--bg-hover);outline:none}.primary{background:var(--accent);color:var(--accent-foreground);border-color:var(--accent)}.primary:hover:not(:disabled),.primary:focus-visible{background:var(--accent-hover);border-color:var(--accent-hover)}.primary:focus-visible{box-shadow:var(--focus-ring)}.button:disabled{opacity:.5;cursor:not-allowed}.message{padding:10px 12px;border-radius:var(--radius-md);background:var(--accent-subtle)}.message--error{color:var(--danger);border:1px solid color-mix(in srgb,var(--danger) 35%,transparent)}.confirm{padding-inline-start:14px;box-shadow:inset 3px 0 0 var(--accent)}
      @media(max-width:560px){.modal{--openclaw-modal-width:calc(100vw - 12px);--openclaw-modal-max-height:calc(100dvh - 12px)}.panel{max-height:calc(100dvh - 12px);border-radius:var(--radius-lg)}header{padding:15px 15px 9px}main{padding:6px 15px 16px}footer{padding:11px 15px}.agent-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start}.agent-heading>div{grid-column:1;grid-row:1/3}.agent-heading>.switch{grid-column:2;grid-row:1;white-space:nowrap;justify-content:flex-end}.agent-heading>.agent-expand{grid-column:2;grid-row:2;white-space:nowrap}.switch b{font-size:11px}.agent-status ul{grid-template-columns:1fr}.agent-actions .button{flex:1 1 calc(50% - 4px)}.agent-actions .primary{flex-basis:100%}}
    </style>`;
}

function renderExecutionAgentField(
  agent: CodingAgentId,
  field: string,
  label: string,
  value: string,
  secondary: string | undefined,
  error: string | undefined,
  busy: boolean,
): string {
  const errorId = `${agent}-${field}-error`;
  return `<label class="field"><span>${escapeHtml(label)}</span>${secondary ? `<small>${escapeHtml(secondary)}</small>` : ""}<input data-agent-field="${agent}-${field}" data-field="${field}" value="${escapeHtml(value)}" placeholder="${escapeHtml(field === "executablePath" ? DEFAULT_EXECUTABLES[agent] : t("platformClaw.execution.agentEnterValue"))}" autocomplete="off" spellcheck="false" ${error ? `aria-invalid="true" aria-describedby="${errorId}"` : ""} maxlength="4096" ${busy ? "disabled" : ""}><span class="field-error" id="${errorId}" data-error-for="${agent}-${field}">${error ? escapeHtml(error) : ""}</span></label>`;
}

export function executionStatusView(
  settings: ExecutionSettings | null,
  activity: ExecutionActivity,
  fallbackMessage: string,
  fallbackKind: "info" | "error",
) {
  const badgeLabel = settings
    ? settings.activeTarget === "assigned_vm"
      ? (settings.assignment?.vmLabel ?? t("platformClaw.execution.vm"))
      : t("platformClaw.execution.basic")
    : t("platformClaw.execution.workLocation");
  const busyMessage = executionBusyMessage(activity);
  let message = busyMessage || fallbackMessage;
  if (activity.kind === "success") {
    message = activity.target
      ? t("platformClaw.execution.usingTarget", {
          target: activity.transition?.to.label ?? executionTargetLabel(activity.target),
        })
      : t(
          activity.action === "credential"
            ? "platformClaw.execution.credentialSaved"
            : activity.action === "test"
              ? "platformClaw.execution.connectionTested"
              : activity.action === "release"
                ? "platformClaw.execution.vmReleased"
                : "platformClaw.execution.saved",
        );
  } else if (activity.kind === "error") {
    message = executionErrorMessage(activity.error);
    if (activity.locationUnknown) {
      message += ` ${t("platformClaw.execution.locationUnknown")}`;
    }
    if (activity.connection === "complete") {
      message = t("platformClaw.execution.activationFailed", { error: message });
    }
    if (!activity.locationUnknown && activity.transition) {
      message += ` ${t("platformClaw.execution.previousLocationKept", { target: settings?.activeTarget === "assigned_vm" ? (settings.assignment?.vmLabel ?? t("platformClaw.execution.vm")) : t("platformClaw.execution.basic") })}`;
    }
  }
  const messageKind =
    activity.kind === "error" ? "error" : activity.kind === "success" ? "success" : fallbackKind;
  const warn =
    !settings ||
    settings.assignment?.status === "connection_required" ||
    settings.credentialStatus === "update_required";
  return { badgeLabel, busyMessage, message, messageKind, warn };
}

export type ExecutionCodingAgentView = {
  configuration: CodingAgentConfiguration;
  saved?: PersonalCodingAgentSettings;
  dirtyFields: readonly string[];
  probe?: CodingAgentProbeResult;
  probeKind?: "detect" | "check";
  probeTime?: number;
  errors: Readonly<Record<string, string>>;
  expanded: boolean;
  gatewayExpanded: boolean;
  busyAction: "detect" | "check" | "save" | null;
};

export function renderExecutionCodingAgents(
  settings: ExecutionSettings,
  busy: boolean,
  agents: readonly ExecutionCodingAgentView[],
): string {
  const assignment = settings.assignment;
  const canProbe = assignment?.status === "ready" && settings.credentialStatus === "current";
  const canEditConfig = Boolean(assignment && assignment.status !== "revoked");
  return `<section class="tab-panel coding-agents" id="execution-panel-agents" role="tabpanel" aria-labelledby="execution-tab-agents">${assignment ? `<p class="agent-context">${escapeHtml(assignment.vmLabel)} · ${escapeHtml(assignment.linuxAccount)}</p><p class="agent-shared-help">${escapeHtml(t("platformClaw.execution.agentOffHelp"))}</p>${agents.map((state) => renderCodingAgent(state, busy, canProbe, canEditConfig)).join("")}` : `<p class="muted">${escapeHtml(t("platformClaw.execution.noAvailableVm"))}</p>`}</section>`;
}

function renderCodingAgent(
  state: ExecutionCodingAgentView,
  busy: boolean,
  canProbe: boolean,
  canEditConfig: boolean,
): string {
  const { configuration, saved } = state;
  const agent = configuration.agent;
  const dirty = state.dirtyFields.length > 0;
  const renderField = (field: string, label: string, value: string, secondary?: string) =>
    renderExecutionAgentField(agent, field, label, value, secondary, state.errors[field], busy);
  const diagnostics = renderExecutionDiagnostics(
    state.probe ?? saved?.lastCheck,
    state.dirtyFields.some((field) => field !== "enabled"),
    state.probeKind === "detect",
    state.probeTime,
  );
  const gatewayComplete =
    configuration.agent === "claude" &&
    CLAUDE_ENVIRONMENT.every(({ key }) => configuration.environment[key].trim());
  const gateway =
    configuration.agent === "claude"
      ? `<details class="gateway" data-claude-gateway ${state.gatewayExpanded || !gatewayComplete ? "open" : ""}><summary><span><strong>${escapeHtml(t("platformClaw.execution.claudeGateway"))}</strong><small>${escapeHtml(t(gatewayComplete ? "platformClaw.execution.claudeGatewayConfigured" : "platformClaw.execution.claudeGatewaySetup"))}</small></span><span class="chevron" aria-hidden="true">⌄</span></summary><div class="gateway-fields"><p class="field-help">${escapeHtml(t("platformClaw.execution.claudeGatewayLiteralHelp"))}</p>${CLAUDE_ENVIRONMENT.map(({ key, labelKey }) => renderField(key, t(labelKey), configuration.environment[key], key)).join("")}</div></details>`
      : "";
  const configurationError = state.errors.configuration;
  const savedEnabled = saved?.configuration.enabled ?? false;
  const expanded = state.expanded;
  const progress =
    state.busyAction !== null
      ? `<p class="agent-progress" role="status" aria-live="polite">${escapeHtml(t(state.busyAction === "check" ? "platformClaw.execution.agentChecking" : state.busyAction === "detect" ? "platformClaw.execution.agentDetecting" : "platformClaw.execution.agentSaving"))}</p>`
      : "";
  return `<section class="agent-card${expanded ? "" : " is-collapsed"}" data-coding-agent="${agent}" ${state.busyAction !== null ? `aria-busy="true"` : ""}><div class="agent-heading"><div><h3>${AGENT_LABELS[agent]}</h3><p>${escapeHtml(savedEnabled ? t("platformClaw.execution.agentSavedOn") : t("platformClaw.execution.agentSavedOff"))}</p>${dirty ? `<p class="unsaved">${escapeHtml(t("platformClaw.execution.agentUnsaved"))}</p>` : ""}<p class="compact-check">${escapeHtml(executionCodingAgentSummary(saved))}</p>${dirty && !expanded ? `<button class="button agent-quick-save" data-agent-quick-save="${agent}" ${!canEditConfig || busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.agentSaveChanges"))}</button>` : ""}</div><button class="agent-expand" data-agent-expand="${agent}" type="button" aria-expanded="${expanded}" aria-controls="agent-settings-${agent}">${escapeHtml(t(expanded ? "platformClaw.execution.agentCollapse" : "platformClaw.execution.agentConfigure"))}</button><label class="switch"><input type="checkbox" role="switch" aria-label="${escapeHtml(t("platformClaw.execution.useAgent", { agent: AGENT_LABELS[agent] }))}" data-agent-toggle="${agent}" ${configuration.enabled ? "checked" : ""} ${!canEditConfig || busy ? "disabled" : ""}><span aria-hidden="true"></span><b>${escapeHtml(t("platformClaw.execution.agentToggleShort"))}</b></label></div><div class="agent-settings" id="agent-settings-${agent}">${progress}${diagnostics}${renderField("executablePath", t("platformClaw.execution.agentExecutable"), configuration.executablePath, t("platformClaw.execution.agentAbsolutePath"))}${gateway}${configurationError ? `<p class="configuration-error" role="alert">${escapeHtml(configurationError)}</p>` : ""}<p class="check-note">${escapeHtml(t("platformClaw.execution.agentCheckTokens"))}</p><div class="agent-actions"><button class="button" data-agent-action="${agent}-detect" ${!canProbe || busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.agentDetect"))}</button><button class="button" data-agent-action="${agent}-check" ${!canProbe || busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.agentCheck"))}</button><button class="button primary" data-agent-action="${agent}-save" ${!canEditConfig || busy ? "disabled" : ""}>${escapeHtml(dirty ? t("platformClaw.execution.agentSaveChanges") : t("platformClaw.execution.agentSave"))}</button></div></div></section>`;
}

export function codingAgentValidationErrors(
  configuration: CodingAgentConfiguration,
  action: "check" | "save",
): Record<string, string> {
  const agent = configuration.agent;
  const errors: Record<string, string> = {};
  const validate = (field: string, label: string, value: string, required: boolean) => {
    if (required && !value.trim()) {
      errors[field] = t("platformClaw.execution.agentFieldRequired", { field: label });
    } else if (hasLiteralSurroundingQuotes(value)) {
      errors[field] = t("platformClaw.execution.agentFieldQuoted", { field: label });
    }
  };
  validate(
    "executablePath",
    `${AGENT_LABELS[agent]} executable`,
    configuration.executablePath,
    action === "check" || configuration.enabled,
  );
  if (configuration.agent === "claude") {
    for (const field of CLAUDE_ENVIRONMENT) {
      validate(
        field.key,
        t(field.labelKey),
        configuration.environment[field.key],
        action === "check" || configuration.enabled,
      );
    }
  }
  if (!Object.keys(errors).length) {
    try {
      parseCodingAgentConfiguration(configuration);
    } catch (error) {
      errors.configuration =
        error instanceof Error
          ? error.message
          : t("platformClaw.execution.agentConfigurationInvalid");
    }
  }
  return errors;
}
