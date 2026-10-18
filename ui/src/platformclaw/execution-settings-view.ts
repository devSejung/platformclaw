import type {
  CodingAgentId,
  CodingAgentProbeResult,
  PersonalCodingAgentSettings,
} from "@platformclaw/coding-agent-contract";
import { platformClawT as t } from "./i18n.ts";

export type ExecutionTarget = "platform_server" | "assigned_vm";
export type ExecutionSettings = {
  activeTarget: ExecutionTarget;
  targetRevision: number;
  credentialStatus: "missing" | "current" | "update_required";
  accountId: string;
  availableVms: Array<{ id: string; label: string }>;
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

export const DEFAULT_EXECUTABLES: Record<CodingAgentId, string> = {
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

export function localizedRequestError(value: unknown, fallbackKey: string): string {
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

export function escapeHtml(value: string): string {
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

export function hasLiteralSurroundingQuotes(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  );
}

export type ExecutionAction = "selection" | "credential" | "test" | "release";
// Keep outcome facts until rendering so an in-flight or completed action follows locale changes.
export type ExecutionActivity =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "switching"; target: ExecutionTarget; connected: boolean }
  | { kind: "working"; action: Exclude<ExecutionAction, "selection"> }
  | { kind: "success"; target: ExecutionTarget | null; connection: "complete" | null }
  | {
      kind: "error";
      error: unknown;
      locationUnknown: boolean;
      connection: "complete" | "failed" | null;
    };

export function renderExecutionProgress(activity: ExecutionActivity): string {
  const connection = "connection" in activity ? activity.connection : null;
  if (
    activity.kind !== "connecting" &&
    !(activity.kind === "switching" && activity.connected) &&
    !connection
  ) {
    return "";
  }
  const state =
    activity.kind === "connecting" ? "active" : connection === "failed" ? "failed" : "complete";
  const activation =
    activity.kind === "connecting" || connection === "failed"
      ? "pending"
      : activity.kind === "switching"
        ? "active"
        : activity.kind === "success"
          ? "complete"
          : "failed";
  return `<ol class="progress" data-connection-progress role="status" aria-live="polite"><li data-step="connection" data-state="${state}"><span class="step-dot" aria-hidden="true"></span>${escapeHtml(t("platformClaw.execution.connectionStep"))}</li><li data-step="activation" data-state="${activation}"><span class="step-dot" aria-hidden="true"></span>${escapeHtml(t("platformClaw.execution.activationStep"))}</li></ol>`;
}

export type VmSelectionDraft = { vmHostId: string; linuxAccount: string };

export function renderExecutionCredentials(settings: ExecutionSettings, busy: boolean): string {
  const open = !(
    settings?.assignment?.status === "ready" && settings.credentialStatus === "current"
  );
  return `<details class="credentials-details" ${open ? "open" : ""}><summary>${escapeHtml(t("platformClaw.execution.changeCredentials"))}</summary><label>${escapeHtml(t("platformClaw.execution.password"))}<input data-password type="password" autocomplete="current-password" maxlength="4096" ${busy ? "disabled" : ""}></label><div class="row"><button class="button primary" data-action="credential" ${busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.saveAndTest"))}</button></div></details>`;
}

export function renderExecutionLocation(
  settings: ExecutionSettings,
  busy: boolean,
  vmDraft: VmSelectionDraft | null,
): string {
  const assignment = settings.assignment;
  const canUseVm = assignment?.status === "ready" && settings.credentialStatus === "current";
  const vmOptions = settings.availableVms
    .map(
      (vm) =>
        `<option value="${escapeHtml(vm.id)}" ${(vmDraft?.vmHostId ?? assignment?.vmHostId) === vm.id ? "selected" : ""}>${escapeHtml(vm.label)}</option>`,
    )
    .join("");
  const badgeLabel =
    settings.activeTarget === "assigned_vm"
      ? t("platformClaw.execution.vm")
      : t("platformClaw.execution.basic");
  const targetActions = `<div class="row">${settings.activeTarget === "platform_server" ? `<span class="current-pill">${escapeHtml(t("platformClaw.execution.currentlyActive"))}</span>` : `<button class="button" data-target="platform_server" ${busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.useBasic"))}</button>`}${settings.activeTarget === "assigned_vm" ? `<span class="current-pill">${escapeHtml(t("platformClaw.execution.currentlyActive"))}</span>` : `<button class="button primary" data-target="assigned_vm" ${!canUseVm || busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.useVm"))}</button>`}</div>`;
  const assignmentCard = assignment
    ? `<section class="card"><h3>${escapeHtml(t("platformClaw.execution.assignedVm"))}</h3><strong>${escapeHtml(assignment.vmLabel)}</strong><p class="muted">${escapeHtml(assignment.linuxAccount)} · ${escapeHtml(assignment.remoteWorkspaceDir ?? t("platformClaw.execution.workspacePending"))}</p><p class="muted">${escapeHtml(t("platformClaw.execution.lastCheck"))}: ${escapeHtml(formatCheckTime(assignment.lastConnectionSucceededAt))}</p><div class="row vm-actions"><button class="button" data-action="test" ${settings.credentialStatus !== "current" || busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.test"))}</button><button class="button" data-action="release" ${settings.activeTarget !== "platform_server" || busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execution.release"))}</button></div>${renderExecutionCredentials(settings, busy)}</section>`
    : "";
  const selection =
    settings.activeTarget === "platform_server"
      ? `<section class="card"><h3>${escapeHtml(t("platformClaw.execution.selectVm"))}</h3>${settings.availableVms.length ? `<form data-action="select-vm"><label>${escapeHtml(t("platformClaw.execution.vmChoice"))}<select name="vmHostId" required ${busy ? "disabled" : ""}>${vmOptions}</select></label><label>${escapeHtml(t("platformClaw.execution.linuxAccount"))}<input name="linuxAccount" value="${escapeHtml(vmDraft?.linuxAccount ?? assignment?.linuxAccount ?? settings.accountId)}" required ${busy ? "disabled" : ""}></label><label>${escapeHtml(t("platformClaw.execution.password"))}<input name="password" type="password" autocomplete="current-password" maxlength="4096" required ${busy ? "disabled" : ""}></label><p class="muted">${escapeHtml(t("platformClaw.execution.selectionHelp"))}</p><button class="button primary" ${busy ? "disabled" : ""}>${escapeHtml(assignment ? t("platformClaw.execution.changeVm") : t("platformClaw.execution.connectVm"))}</button></form>` : `<p class="muted">${escapeHtml(t("platformClaw.execution.noAvailableVm"))}</p>`}</section>`
      : `<section class="card"><p class="muted">${escapeHtml(t("platformClaw.execution.switchBasicToChange"))}</p></section>`;
  return `<section class="tab-panel" id="execution-panel-location" role="tabpanel" aria-labelledby="execution-tab-location"><section class="card"><h3>${escapeHtml(t("platformClaw.execution.current"))}</h3><strong>${escapeHtml(badgeLabel)}</strong><p class="muted">${escapeHtml(t("platformClaw.execution.boundary"))}</p>${targetActions}</section>${assignmentCard}${selection}</section>`;
}

export const executionProgressStyles = `
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

export function executionCodingAgentSummary(saved?: PersonalCodingAgentSettings): string {
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

export function renderExecutionDiagnostics(
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

export function executionTargetLabel(target: ExecutionTarget): string {
  return t(target === "assigned_vm" ? "platformClaw.execution.vm" : "platformClaw.execution.basic");
}

export function executionBusyMessage(activity: ExecutionActivity): string {
  return activity.kind === "connecting"
    ? t("platformClaw.execution.connecting")
    : activity.kind === "switching"
      ? t("platformClaw.execution.switching", { target: executionTargetLabel(activity.target) })
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
      .settings-tabs{--track-width:0;--track-color:transparent;--indicator-color:transparent;display:block;padding:0 22px 10px;border-bottom:1px solid var(--border)}.settings-tabs::part(nav){display:block}.settings-tabs::part(tabs){display:flex;gap:4px;padding:4px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg)}.settings-tabs::part(body){display:none}.settings-tabs wa-tab{flex:1 1 0;min-width:0;border-radius:calc(var(--radius-md) - 2px);color:var(--muted);font-weight:550;transition:color .12s ease}.settings-tabs wa-tab::part(base){display:flex;align-items:center;justify-content:center;width:100%;padding:8px 10px;border-radius:inherit;color:inherit;font:inherit}.settings-tabs wa-tab:hover{color:var(--text)}.settings-tabs wa-tab:hover::part(base),.settings-tabs wa-tab[active]::part(base){background:var(--bg-hover)}.settings-tabs wa-tab[active]{color:var(--text-strong);font-weight:700}.settings-tabs wa-tab:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 22%,transparent);border-radius:var(--radius-sm)}.settings-tabs wa-tab:focus-visible::part(base){outline:none}.tab-panel{display:grid;gap:14px}.current-pill{display:inline-flex;padding:7px 10px;border-radius:var(--radius-md);background:var(--accent-subtle);color:var(--accent);font-weight:700}.credentials-details{margin-top:10px;border-top:1px solid var(--border);padding-top:9px}.credentials-details summary{cursor:pointer;font-weight:700}.credentials-details[open] summary{margin-bottom:8px}.agent-context,.agent-shared-help{margin:0;color:var(--muted)}.agent-context{font-weight:700;color:var(--text)}.agent-card.is-collapsed>.agent-settings{display:none}.agent-settings{display:grid;gap:12px}.compact-check{margin-top:4px!important}.agent-quick-save{margin-top:7px;padding:5px 8px;font-size:12px}.agent-progress{margin:0;padding:8px 10px;border-radius:var(--radius-md);background:var(--accent-subtle);font-weight:700}.agent-expand{border:0;background:transparent;color:var(--accent);padding:5px;cursor:pointer}.agent-expand:focus-visible{outline:none;box-shadow:var(--focus-ring)}
      .agent-status ul.is-stale{opacity:.5}.stale-status,.unsaved{margin:0 0 6px;color:var(--warn);font-size:12px}
      :host{display:block;color:var(--text);font:13px/1.45 var(--font-sans,system-ui,sans-serif)}button,input,select{font:inherit}*{box-sizing:border-box}.badge{display:flex;width:100%;min-height:34px;align-items:center;gap:8px;border:0;border-radius:var(--radius-md);padding:7px 9px;background:transparent;color:var(--text);cursor:pointer;text-align:left}.badge:hover,.badge:focus-visible{background:var(--bg-hover);outline:none}.dot{width:7px;height:7px;flex:none;border-radius:var(--radius-full);background:${warn ? "var(--warn)" : "var(--ok)"}}
      .modal{--openclaw-modal-width:min(680px,calc(100vw - 32px));--openclaw-modal-max-height:min(820px,calc(100dvh - 24px))}.panel{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:min(680px,100%);max-height:min(820px,calc(100dvh - 24px));overflow:hidden;border-radius:var(--radius-xl);background:var(--bg-elevated);color:var(--text);box-shadow:var(--shadow-xl);border:1px solid var(--border)}header{display:flex;justify-content:space-between;align-items:center;padding:20px 22px 12px}h2{margin:0;font-size:20px}h3{margin:0;font-size:15px}.close{border:0;background:transparent;color:inherit;font-size:22px;cursor:pointer}main{min-height:0;overflow:auto;padding:8px 22px 22px;display:grid;gap:14px}footer{padding:14px 22px;border-top:1px solid var(--border);background:var(--bg-elevated)}footer h3,footer p{margin:0}footer p{margin-top:6px}footer .row{margin-top:12px}.card,.agent-card{padding:15px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--card)}
      .coding-agents{display:grid;gap:10px}.coding-agents>h3{margin-top:2px}.agent-card{display:grid;gap:12px}.agent-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.agent-heading p,.disable-note,.check-note{margin:3px 0 0;color:var(--muted);font-size:12px}.disable-note{margin-top:-7px}.check-note{margin:0}.switch{display:flex;align-items:center;gap:7px;cursor:pointer;white-space:nowrap}.switch input{position:absolute;opacity:0;pointer-events:none}.switch span{position:relative;width:34px;height:20px;border-radius:99px;background:var(--border-strong);transition:background .15s ease}.switch span::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:white;box-shadow:0 1px 3px #0005;transition:transform .15s ease}.switch input:checked+span{background:var(--accent)}.switch input:checked+span::after{transform:translateX(14px)}.switch input:focus-visible+span{box-shadow:var(--focus-ring)}.switch input:disabled~*{opacity:.5;cursor:not-allowed}.switch b{font-size:12px}
      .agent-status ul{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:0;padding:0;list-style:none}.diagnostic{display:flex;gap:7px;min-width:0;padding:8px;border-radius:var(--radius-md);background:var(--bg);border:1px solid var(--border)}.diagnostic>span:first-child{display:grid;place-items:center;width:18px;height:18px;flex:none;border-radius:50%;font-weight:700;background:var(--bg-hover)}.diagnostic--passed>span:first-child{color:var(--ok)}.diagnostic--failed>span:first-child{color:var(--danger)}.diagnostic strong,.diagnostic small{display:block;overflow:hidden;text-overflow:ellipsis}.diagnostic small{color:var(--muted);margin-top:2px}.version{margin:6px 0 0;color:var(--muted);font-size:12px}.field{display:grid;gap:5px}.field>span:first-child{font-weight:600}.field small{color:var(--muted);font-family:var(--font-mono,monospace);font-size:11px}input,select{width:100%;padding:9px 10px;border-radius:var(--radius-md);border:1px solid var(--border-strong);background:var(--bg);color:var(--text)}input:focus,select:focus{border-color:var(--accent);outline:none;box-shadow:var(--focus-ring)}input[aria-invalid=true]{border-color:var(--danger)}.field-error{color:var(--danger);font-size:12px}.field-error:empty{display:none}
      .gateway{border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden}.gateway summary{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;padding:10px 11px;background:var(--bg)}.gateway summary::-webkit-details-marker{display:none}.gateway summary span:first-child{display:grid}.gateway summary small{color:var(--muted)}.gateway[open] .chevron{transform:rotate(180deg)}.gateway-fields{display:grid;gap:10px;padding:12px;border-top:1px solid var(--border)}.field-help{margin:0;color:var(--muted)}.configuration-error{margin:0;color:var(--danger);font-size:12px}.muted{color:var(--muted);margin:4px 0}.row,.agent-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.agent-actions{padding-top:2px}.button{border:1px solid var(--border-strong);border-radius:var(--radius-md);padding:8px 11px;background:var(--bg-elevated);color:var(--text);cursor:pointer}.button:hover:not(:disabled),.button:focus-visible{border-color:var(--border-hover);background:var(--bg-hover);outline:none}.primary{background:var(--accent);color:var(--accent-foreground);border-color:var(--accent)}.primary:hover:not(:disabled),.primary:focus-visible{background:var(--accent-hover);border-color:var(--accent-hover)}.primary:focus-visible{box-shadow:var(--focus-ring)}.button:disabled{opacity:.5;cursor:not-allowed}.message{padding:10px 12px;border-radius:var(--radius-md);background:var(--accent-subtle)}.message--error{color:var(--danger);border:1px solid color-mix(in srgb,var(--danger) 35%,transparent)}.confirm{padding-inline-start:14px;box-shadow:inset 3px 0 0 var(--accent)}
      @media(max-width:560px){.modal{--openclaw-modal-width:calc(100vw - 12px);--openclaw-modal-max-height:calc(100dvh - 12px)}.panel{max-height:calc(100dvh - 12px);border-radius:var(--radius-lg)}header{padding:15px 15px 9px}main{padding:6px 15px 16px}footer{padding:11px 15px}.agent-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start}.agent-heading>div{grid-column:1;grid-row:1/3}.agent-heading>.switch{grid-column:2;grid-row:1;white-space:nowrap;justify-content:flex-end}.agent-heading>.agent-expand{grid-column:2;grid-row:2;white-space:nowrap}.switch b{font-size:11px}.agent-status ul{grid-template-columns:1fr}.agent-actions .button{flex:1 1 calc(50% - 4px)}.agent-actions .primary{flex-basis:100%}}
    </style>`;
}

export function renderExecutionAgentField(
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
      ? t("platformClaw.execution.vm")
      : t("platformClaw.execution.basic")
    : t("platformClaw.execution.workLocation");
  const busyMessage = executionBusyMessage(activity);
  let message = busyMessage || fallbackMessage;
  if (activity.kind === "success") {
    message = activity.target
      ? t("platformClaw.execution.usingTarget", { target: executionTargetLabel(activity.target) })
      : t("platformClaw.execution.saved");
  } else if (activity.kind === "error") {
    message = executionErrorMessage(activity.error);
    if (activity.locationUnknown) {
      message += ` ${t("platformClaw.execution.locationUnknown")}`;
    }
    if (activity.connection === "complete") {
      message = t("platformClaw.execution.activationFailed", { error: message });
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
