import { html, nothing, svg } from "lit";
import { strokeIcon } from "../components/icons-tools.ts";
import {
  type ExecutionActivity,
  type ExecutionSettings,
  type ExecutionTarget,
  type VmSelectionDraft,
  canActivateVerifiedVm,
  executionStatusView,
  formatCheckTime,
  hasExecutionProgress,
} from "./execution-settings-view.ts";
import { platformClawT as t } from "./i18n.ts";

const serverIcon = strokeIcon(
  svg`<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>`,
);
const vmIcon = strokeIcon(
  svg`<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="6" width="12" height="5" rx="1"/><rect x="6" y="13" width="12" height="5" rx="1"/><path d="M9 8.5h.01M9 15.5h.01M12 8.5h3M12 15.5h3"/>`,
);
const changeVmIcon = strokeIcon(svg`<path d="m16 3 4 4-4 4M20 7H4m4 14-4-4 4-4M4 17h16"/>`);

export function executionServerIcon(target: ExecutionTarget) {
  return target === "platform_server" ? serverIcon : vmIcon;
}

function targetLabel(target: ExecutionTarget) {
  return t(
    target === "platform_server" ? "platformClaw.execution.basic" : "platformClaw.execution.vm",
  );
}

export function isVmCardActivity(activity: ExecutionActivity) {
  return (
    activity.kind === "working" ||
    ((activity.kind === "success" || activity.kind === "error") &&
      (activity.action === "credential" ||
        activity.action === "test" ||
        activity.action === "release" ||
        (activity.action === "selection" && activity.kind === "error")))
  );
}

type LocationOptions = {
  settings: ExecutionSettings;
  busy: boolean;
  editingVm: boolean;
  vmDraft: VmSelectionDraft | null;
  activity: ExecutionActivity;
  progressVisible: boolean;
};

function renderCurrentLocation(settings: ExecutionSettings, busy: boolean) {
  const canUseVm =
    settings.assignment?.status === "ready" && settings.credentialStatus === "current";
  return html`<section class="current-location-card" data-current-location>
    <h3>${t("platformClaw.execution.current")}</h3>
    <span class="sr-only" data-current-target role="status" aria-live="polite" aria-atomic="true"
      >${targetLabel(settings.activeTarget)}</span
    >
    <div class="location-targets">
      ${(["platform_server", "assigned_vm"] as const).map((target) => {
        const selected = settings.activeTarget === target;
        return html`<button
          class="location-tile"
          data-target=${target}
          aria-label=${t(
            target === "platform_server"
              ? "platformClaw.execution.useBasic"
              : "platformClaw.execution.useVm",
          )}
          aria-pressed=${String(selected)}
          ?disabled=${busy || selected || (target === "assigned_vm" && !canUseVm)}
        >
          ${executionServerIcon(target)}<strong>${targetLabel(target)}</strong>
          <span class="location-selected" aria-hidden="true">${selected ? "✓" : ""}</span>
          ${selected
            ? html`<span class="sr-only">${t("platformClaw.execution.currentlyActive")}</span>`
            : nothing}
        </button>`;
      })}
    </div>
    <p class="muted location-boundary">${t("platformClaw.execution.boundary")}</p>
  </section>`;
}

function renderSelection(options: LocationOptions) {
  const { settings, busy, vmDraft } = options;
  if (!settings.availableVms.length) {
    return html`<p class="muted">${t("platformClaw.execution.noAvailableVm")}</p>`;
  }
  return html`<form class="vm-form" data-action="select-vm">
    <label
      >${t("platformClaw.execution.vmChoice")}<select name="vmHostId" required ?disabled=${busy}>
        ${settings.availableVms.map(
          (vm) =>
            html`<option
              value=${vm.id}
              ?selected=${(vmDraft?.vmHostId ?? settings.assignment?.vmHostId) === vm.id}
            >
              ${vm.label}
            </option>`,
        )}
      </select></label
    >
    <label
      >${t("platformClaw.execution.linuxAccount")}<input
        name="linuxAccount"
        .value=${vmDraft?.linuxAccount ?? settings.assignment?.linuxAccount ?? settings.accountId}
        required
        ?disabled=${busy}
    /></label>
    <p class="muted vm-form-help">${t("platformClaw.execution.selectionHelp")}</p>
    <label
      >${t("platformClaw.execution.password")}<input
        name="password"
        type="password"
        autocomplete="current-password"
        maxlength="4096"
        required
        ?disabled=${busy}
    /></label>
    <div class="row">
      <button class="button primary" type="submit" ?disabled=${busy}>
        ${t("platformClaw.execution.connectVm")}
      </button>
      ${settings.assignment
        ? html`<button class="button" type="button" data-action="cancel-edit-vm" ?disabled=${busy}>
            ${t("platformClaw.execution.cancel")}
          </button>`
        : nothing}
    </div>
  </form>`;
}

function renderRenewal(options: LocationOptions) {
  const { settings, busy } = options;
  return html`<form class="vm-form renewal-form" data-action="update-credential">
    <label
      >${t("platformClaw.execution.password")}<input
        name="password"
        data-password
        type="password"
        autocomplete="current-password"
        maxlength="4096"
        required
        ?disabled=${busy}
    /></label>
    <p class="muted vm-form-help">${t("platformClaw.execution.credentialHelp")}</p>
    <div class="row">
      <button
        class="button primary"
        type="submit"
        data-action="credential"
        ?disabled=${busy || settings.assignment?.status === "revoked"}
      >
        ${t("platformClaw.execution.saveAndTest")}
      </button>
      <button
        class="button"
        type="button"
        data-action="test"
        ?disabled=${busy ||
        settings.credentialStatus !== "current" ||
        settings.assignment?.status === "revoked"}
      >
        ${t("platformClaw.execution.test")}
      </button>
    </div>
  </form>`;
}

function renderVmStatus(options: LocationOptions) {
  if (!isVmCardActivity(options.activity)) {
    return nothing;
  }
  const { message, messageKind } = executionStatusView(
    options.settings,
    options.activity,
    "",
    "info",
  );
  const canReopen =
    !options.progressVisible &&
    hasExecutionProgress(options.activity) &&
    (options.activity.kind !== "success" ||
      canActivateVerifiedVm(options.settings, options.activity));
  return html`<div
    class="vm-status vm-status--${messageKind}"
    data-vm-status
    role=${messageKind === "error" ? "alert" : "status"}
    aria-live="polite"
  >
    ${message}${canReopen
      ? html`<button class="button" type="button" data-action="show-progress">
          ${t("platformClaw.execution.progressReopen")}
        </button>`
      : nothing}
  </div>`;
}

export function renderExecutionLocation(options: LocationOptions) {
  const { settings, busy, editingVm } = options;
  const assignment = settings.assignment;
  const ready = assignment?.status === "ready" && settings.credentialStatus === "current";
  const choosing = !assignment || (editingVm && settings.activeTarget === "platform_server");
  return html`<section
    class="tab-panel"
    id="execution-panel-location"
    role="tabpanel"
    aria-labelledby="execution-tab-location"
  >
    ${renderCurrentLocation(settings, busy)}
    <section class="card vm-connection-card" data-vm-connection>
      <div class="vm-card-heading">
        <h3>${t("platformClaw.execution.vmConnection")}</h3>
        ${assignment && !choosing
          ? html`<button
              class="button vm-edit"
              type="button"
              data-action="edit-vm"
              ?disabled=${busy || settings.activeTarget !== "platform_server"}
              title=${settings.activeTarget !== "platform_server"
                ? t("platformClaw.execution.switchBasicToChange")
                : ""}
            >
              ${changeVmIcon}${t("platformClaw.execution.editVm")}
            </button>`
          : nothing}
      </div>
      ${assignment && settings.activeTarget !== "platform_server"
        ? html`<p class="muted vm-form-help">${t("platformClaw.execution.switchBasicToChange")}</p>`
        : nothing}
      ${assignment && !choosing
        ? html`<div class="vm-summary">
            <div>
              <strong>${assignment.vmLabel}</strong
              ><span class="muted">${assignment.linuxAccount}</span>
            </div>
            <span class="vm-connection-state" data-ready=${String(ready)}
              >${t(
                ready
                  ? "platformClaw.execution.connectionReady"
                  : assignment.status === "revoked"
                    ? "platformClaw.execution.connectionUnavailable"
                    : "platformClaw.execution.connectionRequired",
              )}</span
            >
          </div>`
        : nothing}
      ${renderVmStatus(options)} ${choosing ? renderSelection(options) : renderRenewal(options)}
      ${assignment && !choosing
        ? html`<details class="connection-details">
            <summary>${t("platformClaw.execution.connectionDetails")}</summary>
            <p class="muted">
              ${assignment.remoteWorkspaceDir ?? t("platformClaw.execution.workspacePending")}
            </p>
            <p class="muted">
              ${t("platformClaw.execution.lastCheck")}:
              ${formatCheckTime(assignment.lastConnectionSucceededAt)}
            </p>
            <button
              class="button"
              type="button"
              data-action="release"
              ?disabled=${busy || settings.activeTarget !== "platform_server"}
            >
              ${t("platformClaw.execution.release")}
            </button>
          </details>`
        : nothing}
    </section>
  </section>`;
}

export const executionLocationStyles = `
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .current-location-card{display:grid;gap:10px}.location-targets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .location-tile{display:grid;grid-template-columns:28px minmax(0,1fr) 16px;align-items:center;gap:9px;height:62px;min-width:0;padding:10px 12px;text-align:start;border:1px solid var(--border-strong);border-radius:var(--radius-md);background:var(--card);color:var(--text);cursor:pointer}
  .location-tile>svg{width:27px;height:27px;color:var(--muted)}.location-tile strong{font-size:13px;line-height:1.3}.location-selected{color:var(--ok);font-weight:700}.location-tile[aria-pressed="true"]{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 7%,var(--card));cursor:default}.location-tile[aria-pressed="true"]>svg{color:var(--ok)}.location-tile:disabled[aria-pressed="false"]{opacity:.5;cursor:not-allowed}.location-tile:hover:not(:disabled){background:var(--bg-hover)}.location-tile:focus-visible{outline:none;box-shadow:var(--focus-ring)}.location-boundary{font-size:12px;line-height:1.4;margin:0}
  .vm-connection-card{display:grid;gap:14px}.vm-card-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.vm-edit{display:inline-flex;align-items:center;gap:5px;padding:5px 8px;font-size:12px}.vm-edit>svg{width:14px;height:14px}.vm-summary{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-bottom:12px;border-bottom:1px solid var(--border)}.vm-summary>div{display:grid;gap:3px}.vm-summary .muted{margin:0;font-size:12px}.vm-connection-state{font-size:12px;color:var(--warn)}.vm-connection-state[data-ready="true"]{color:var(--ok)}
  .vm-form{display:grid;gap:12px}.vm-form label{display:grid;gap:6px;font-weight:600}.vm-form .row{margin:0}.vm-form-help{margin:0;font-size:12px}.vm-status{padding:10px 12px;border-radius:var(--radius-md);background:var(--bg);line-height:1.5}.vm-status--error{color:var(--danger);border-inline-start:3px solid var(--danger)}.vm-status--success{color:var(--ok)}.vm-status .button{margin-top:8px}.connection-details{border-top:1px solid var(--border);padding-top:12px}.connection-details summary{cursor:pointer;color:var(--muted);font-size:12px}.connection-details p{overflow-wrap:anywhere;font-size:12px}.connection-details .button{margin-top:8px;font-size:12px}
  @media(max-width:400px){.location-tile{grid-template-columns:23px minmax(0,1fr) 12px;padding:9px 8px;gap:6px}.location-tile>svg{width:23px;height:23px}.location-tile strong{font-size:12px}.vm-summary{align-items:flex-start}.vm-connection-state{max-width:100px;text-align:end}}
`;
