import { html, nothing, svg } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { strokeIcon } from "../components/icons-tools.ts";
import { icons } from "../components/icons.ts";
import {
  executionServerIcon,
  executionLocationStyles,
  isVmCardActivity,
  renderExecutionLocation,
} from "./execution-location-view.ts";
import {
  type ExecutionActivity,
  type ExecutionSettings,
  type ExecutionTarget,
  type VmSelectionDraft,
  executionStatusView,
  canActivateVerifiedVm,
  hasExecutionProgress,
  isCredentialProgress,
  renderExecutionSettingsStyles,
  renderExecutionTabs,
} from "./execution-settings-view.ts";
import { platformClawT as t } from "./i18n.ts";

export const EXECUTION_PROGRESS_SUCCESS_DELAY_MS = 800;

type SettingsShellOptions = {
  settings: ExecutionSettings | null;
  activity: ExecutionActivity;
  opened: boolean;
  progressVisible: boolean;
  busy: boolean;
  loading: boolean;
  pendingRelease: boolean;
  activeTab: "location" | "agents";
  bodyMarkup: string;
  vmDraft: VmSelectionDraft | null;
  editingVm: boolean;
  message: string;
  messageKind: "info" | "error";
  canRetryProgress: boolean;
};

const checkIcon = strokeIcon(svg`<path d="m5 12 4 4 10-10"/>`);
const credentialIcon = strokeIcon(
  svg`<circle cx="7" cy="8" r="4"/><path d="m10 11 10 10M15 16l3-3M17 18l3-3"/>`,
);
const errorIcon = strokeIcon(svg`<path d="m7 7 10 10M17 7 7 17"/>`);
const transferIcon = strokeIcon(svg`<path d="M5 12h14m-6-6 6 6-6 6"/>`);

function progressTarget(activity: ExecutionActivity): ExecutionTarget {
  return "target" in activity && activity.target ? activity.target : "assigned_vm";
}

function renderProgressPanel(options: SettingsShellOptions, message: string) {
  const activity = options.activity;
  if (!hasExecutionProgress(activity)) {
    return nothing;
  }
  const credential = isCredentialProgress(activity);
  const offerActivation = canActivateVerifiedVm(options.settings, activity);
  const target = progressTarget(activity);
  const hasConnection =
    activity.kind === "connecting" ||
    (activity.kind === "switching" && activity.connected) ||
    ("connection" in activity && activity.connection !== null);
  const connection =
    activity.kind === "connecting"
      ? "active"
      : activity.kind === "error" && activity.connection === "failed"
        ? "failed"
        : "complete";
  const activation =
    activity.kind === "connecting" ||
    (activity.kind === "error" && activity.connection === "failed")
      ? "pending"
      : activity.kind === "switching"
        ? "active"
        : activity.kind === "success"
          ? "complete"
          : "failed";
  const headingKey = credential
    ? activity.kind === "working"
      ? "credentialVerifyingTitle"
      : activity.kind === "success"
        ? "credentialSuccessTitle"
        : "credentialFailureTitle"
    : activity.kind === "connecting"
      ? "progressConnectingTitle"
      : activity.kind === "switching"
        ? "progressSwitchingTitle"
        : activity.kind === "success"
          ? "progressSuccessTitle"
          : "progressFailureTitle";
  const from = activity.transition?.from ?? { target: "platform_server" as const };
  const to = activity.transition?.to ?? { target };
  const locationLabel = (location: typeof from) =>
    location.label ??
    t(
      location.target === "platform_server"
        ? "platformClaw.execution.basic"
        : "platformClaw.execution.vm",
    );
  const busy =
    activity.kind === "connecting" ||
    activity.kind === "switching" ||
    (credential && activity.kind === "working");
  return html`<section
    class="progress-panel"
    data-progress-panel
    data-phase=${activity.kind}
    data-operation=${credential ? "credential" : "target"}
    ?data-compact=${!credential && !hasConnection}
  >
    <button
      class="progress-close"
      data-action="hide-progress"
      aria-label=${t("platformClaw.execution.progressHide")}
    >
      ×
    </button>
    <div
      class="execution-diagram"
      aria-hidden="true"
      data-direction=${credential ? "credential" : "forward"}
    >
      <div
        class="execution-endpoint execution-source"
        data-endpoint=${credential ? "credential" : (from.connectionId ?? from.target)}
      >
        ${credential ? credentialIcon : executionServerIcon(from.target)}<span
          title=${credential ? t("platformClaw.execution.credentialSource") : locationLabel(from)}
          >${credential ? t("platformClaw.execution.credentialSource") : locationLabel(from)}</span
        >
      </div>
      <div class="execution-link">
        <span class="execution-track"><span class="execution-route-fill"></span></span
        ><span class="execution-packet"></span>
        <span class="execution-transfer"><span>${transferIcon}</span></span>
        <span class="execution-orb"
          ><span class="execution-spinner" ?hidden=${!busy}></span
          ><span class="execution-check" ?hidden=${activity.kind !== "success"}>${checkIcon}</span
          ><span class="execution-failure" ?hidden=${activity.kind !== "error"}
            >${errorIcon}</span
          ></span
        >
      </div>
      <div
        class="execution-endpoint execution-destination"
        data-endpoint=${to.connectionId ?? to.target}
      >
        ${executionServerIcon(credential ? "assigned_vm" : to.target)}<span
          title=${credential
            ? (options.settings?.assignment?.vmLabel ?? t("platformClaw.execution.vm"))
            : locationLabel(to)}
          >${credential
            ? (options.settings?.assignment?.vmLabel ?? t("platformClaw.execution.vm"))
            : locationLabel(to)}</span
        >
      </div>
    </div>
    <h2>${t(`platformClaw.execution.${headingKey}`)}</h2>
    <p class="progress-message" role=${activity.kind === "error" ? "alert" : "status"}>
      ${message}
    </p>
    <ol class="progress" data-connection-progress role="status" aria-live="polite">
      ${credential
        ? html`<li
            data-step="credential"
            data-state=${activity.kind === "working"
              ? "active"
              : activity.kind === "success"
                ? "complete"
                : "failed"}
          >
            <span class="step-dot" aria-hidden="true"></span>${t(
              "platformClaw.execution.credentialStep",
            )}
          </li>`
        : html`${hasConnection
              ? html`<li data-step="connection" data-state=${connection}>
                  <span class="step-dot" aria-hidden="true"></span>${t(
                    "platformClaw.execution.connectionStep",
                  )}
                </li>`
              : nothing}
            <li data-step="activation" data-state=${activation}>
              <span class="step-dot" aria-hidden="true"></span>${t(
                hasConnection
                  ? "platformClaw.execution.activationStep"
                  : "platformClaw.execution.progressSwitchStep",
              )}
            </li>`}
    </ol>
    <footer class="progress-footer">
      ${busy ? html`<p>${t("platformClaw.execution.progressBackground")}</p>` : nothing}
      ${offerActivation
        ? html`<div class="activation-offer" data-activation-offer>
            <p>${t("platformClaw.execution.activateVmPrompt")}</p>
            <div class="row">
              <button class="button primary" data-action="activate-verified-vm">
                ${t("platformClaw.execution.useVm")}
              </button>
              <button class="button" data-action="hide-progress">
                ${t("platformClaw.execution.later")}
              </button>
            </div>
          </div>`
        : nothing}
      ${activity.kind === "error"
        ? html`<div class="row">
            ${options.canRetryProgress
              ? html`<button class="button primary" data-action="retry-progress">
                  ${t("platformClaw.execution.progressRetry")}
                </button>`
              : nothing}<button class="button" data-action="back-to-settings">
              ${t("platformClaw.execution.progressBack")}
            </button>
          </div>`
        : nothing}
    </footer>
  </section>`;
}

const shellStyles = `
  .badge>svg{width:16px;height:16px;flex:none}
  .panel main,.panel .tab-panel{align-content:start}
  .header-actions{display:flex;align-items:center;gap:8px}.refresh-icon{display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:var(--radius-md);background:transparent;color:var(--muted);cursor:pointer}.refresh-icon>svg{width:17px;height:17px}.refresh-icon:hover:not(:disabled){background:var(--bg-hover)}.refresh-icon:focus-visible{outline:none;box-shadow:var(--focus-ring)}.refresh-icon:disabled{opacity:.5;cursor:not-allowed}
  .panel[data-settings-panel]{height:min(720px,calc(100dvh - 48px));grid-template-rows:auto auto minmax(0,1fr) auto}
  .settings-content{display:contents;border:0;padding:0;margin:0;min-width:0}
  .progress-modal{--openclaw-modal-width:min(440px,calc(100vw - 32px));--openclaw-modal-max-height:calc(100dvh - 32px);--openclaw-modal-backdrop-filter:none;--wa-color-overlay-modal:transparent;--wa-transition-normal:160ms}
  .progress-panel{position:relative;display:grid;grid-template-rows:60px auto 40px auto auto;align-content:start;gap:8px;box-sizing:border-box;width:100%;height:min(312px,calc(90dvh - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:18px;border:1px solid var(--border-strong);border-radius:var(--radius-xl);background:var(--bg-elevated);color:var(--text);box-shadow:var(--shadow-xl)}
  .progress-panel[data-compact]{height:min(288px,calc(90dvh - 32px));padding:16px}
  .progress-close{position:absolute;inset-block-start:9px;inset-inline-end:12px;border:0;background:transparent;color:var(--muted);font:24px/1 var(--font-sans);cursor:pointer;padding:5px}
  .progress-panel h2{margin:0;text-align:center;font-size:20px;line-height:1.3}
  .progress-message{margin:0;max-height:40px;overflow:auto;text-align:center;color:var(--muted);line-height:1.5}
  .progress-panel[data-phase="error"] .progress-message{color:var(--danger)}
  .progress-panel .progress{padding:10px;gap:8px;align-self:start;background:var(--bg);font-size:12px}
  .progress-footer{min-height:44px;padding:0;border:0;background:transparent;display:grid;place-items:center;align-content:start}
  .progress-footer p{margin:0;text-align:center;color:var(--muted);font-size:12px;line-height:1.45}
  .progress-footer .row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;width:100%;margin:0}
  .progress-footer .button:only-child{grid-column:1/-1}
  .activation-offer{display:grid;gap:12px;width:100%}
  .activation-offer .row{grid-template-columns:minmax(0,1fr) auto}
  .execution-diagram{display:grid;grid-template-columns:94px minmax(70px,1fr) 94px;align-items:center;gap:8px;padding:4px 0 0;color:var(--run)}
  .execution-endpoint{display:grid;min-width:0;justify-items:center;align-content:center;gap:4px;color:var(--muted);font-size:11px;text-align:center}.execution-endpoint>span{max-width:100%;overflow-wrap:anywhere;line-height:13px;max-height:26px;overflow:hidden}
  .execution-endpoint>svg{width:28px;height:28px;stroke-width:1.5;border-radius:6px}
  .execution-destination{color:var(--run)}
  .execution-link{position:relative;align-self:start;height:38px;display:grid;place-items:center;overflow:clip}
  .execution-track{position:absolute;inset-inline:0;height:1px;background:var(--border-strong)}
  .execution-route-fill{display:block;width:100%;height:2px;background:var(--run);transform:scaleX(0);transform-origin:left}
  .execution-transfer{position:absolute;inset:0 24px 0 0;display:none;align-items:center;pointer-events:none}
  .execution-transfer>span{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--run);color:var(--bg-elevated);box-shadow:0 0 0 4px var(--bg-elevated)}
  .execution-transfer svg{width:16px;height:16px}
  [data-phase="switching"] .execution-transfer{display:flex;animation:execution-transfer 700ms cubic-bezier(.2,.8,.2,1) both}
  [data-phase="switching"] .execution-route-fill{animation:execution-route 700ms cubic-bezier(.2,.8,.2,1) both}
  [data-phase="switching"] .execution-source>svg{opacity:.45}
  [data-phase="switching"] .execution-destination>svg{animation:execution-arrival 1.1s ease-out infinite}
  [data-phase="switching"] .execution-orb{visibility:hidden}
  [data-phase="success"][data-operation="target"] .execution-route-fill{transform:scaleX(1);background:var(--ok)}
  .execution-packet{position:absolute;inset-inline-start:0;width:6px;height:6px;border-radius:50%;background:var(--run);opacity:0}
  [data-phase="connecting"] .execution-packet,[data-operation="credential"][data-phase="working"] .execution-packet{animation:execution-packet 1.2s ease-in-out infinite}
  .execution-orb{z-index:1;display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--bg-elevated)}
  .execution-orb>span{grid-area:1/1;display:grid;place-items:center}
  .execution-orb svg{width:24px;height:24px}
  .execution-spinner{width:20px;height:20px;box-sizing:border-box;border:2px solid var(--border-strong);border-top-color:var(--run);border-radius:50%;animation:execution-spin 1s linear infinite}
  .execution-check{color:var(--ok)}
  .execution-check svg path{stroke-dasharray:28;stroke-dashoffset:0}
  [data-phase="success"] .execution-check svg path{animation:execution-check 280ms ease-out}
  [data-phase="success"] .execution-destination{color:var(--ok)}
  [data-phase="success"] .execution-destination>svg{animation:execution-arrival 500ms ease-out;box-shadow:0 0 0 5px color-mix(in srgb,var(--ok) 12%,transparent)}
  .execution-failure{color:var(--danger)}
  @keyframes execution-packet{0%{left:0;opacity:0}20%{opacity:1}80%{opacity:1}100%{left:calc(100% - 6px);opacity:0}}
  @keyframes execution-check{from{stroke-dashoffset:28}to{stroke-dashoffset:0}}
  @keyframes execution-transfer{from{transform:translateX(var(--execution-from,0%))}to{transform:translateX(var(--execution-to,100%))}}
  @keyframes execution-route{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  @keyframes execution-arrival{0%{box-shadow:0 0 0 0 color-mix(in srgb,currentColor 28%,transparent)}100%{box-shadow:0 0 0 10px transparent}}
  @media(max-width:560px){.panel[data-settings-panel]{height:min(720px,calc(90dvh - 24px))}.progress-panel{height:min(324px,calc(90dvh - 32px));padding:18px 16px}.execution-diagram{grid-template-columns:minmax(0,1fr) minmax(38px,.9fr) minmax(0,1fr)}.progress-footer .button{min-height:40px}}
  @media(prefers-reduced-motion:reduce){.execution-packet,.execution-spinner,.execution-check svg path,.execution-transfer,.execution-route-fill,.execution-endpoint>svg,.step-dot{animation:none!important}.execution-packet{display:none}.execution-transfer{transform:translateX(50%)}[data-phase="switching"] .execution-route-fill{transform:scaleX(1)}.progress-modal{--wa-transition-normal:0ms}}
`;

export function renderExecutionSettingsShell(options: SettingsShellOptions) {
  const { busyMessage, message, messageKind, warn } = executionStatusView(
    options.settings,
    options.activity,
    options.message,
    options.messageKind,
  );
  const inlineVmActivity =
    options.activeTab === "location" && options.settings && isVmCardActivity(options.activity);
  const locationSuccess = options.activity.kind === "success" && options.activity.target !== null;
  const hasProgressOutcome = hasExecutionProgress(options.activity);
  return html`${unsafeHTML(renderExecutionSettingsStyles(warn))}<style>
      ${shellStyles}
      ${executionLocationStyles}
    </style>
    <button
      class="badge"
      data-action="open"
      aria-busy=${String(options.busy)}
      aria-label=${t("platformClaw.execution.openSettings")}
    >
      ${busyMessage ? html`<span class="dot" aria-hidden="true"></span>` : icons.monitor}
      <span>${busyMessage || t("platformClaw.execution.workLocation")}</span>
    </button>
    <openclaw-modal-dialog
      data-settings-modal
      class="modal"
      .open=${options.opened}
      .label=${t("platformClaw.execution.workEnvironmentSettings")}
    >
      <section class="panel" data-settings-panel>
        <header>
          <h2 data-settings-heading tabindex="-1">
            ${t("platformClaw.execution.workEnvironmentSettings")}
          </h2>
          <div class="header-actions">
            <button
              class="refresh-icon"
              data-action="refresh"
              aria-label=${t("platformClaw.execution.refresh")}
              title=${t("platformClaw.execution.refresh")}
              ?disabled=${options.busy || options.loading}
            >
              ${strokeIcon(
                svg`<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.55-2.6L20 7M4 17l2.35 2.6A7 7 0 0 0 17.9 17"/>`,
              )}</button
            ><button
              class="close"
              data-action="close"
              aria-label=${t("platformClaw.execution.close")}
            >
              ×
            </button>
          </div>
        </header>
        <div ?inert=${options.busy || options.loading}>
          ${unsafeHTML(renderExecutionTabs(options.activeTab))}
        </div>
        <main aria-busy=${String(options.busy)}>
          ${options.loading ? html`<p>${t("common.loading")}</p>` : nothing}
          ${!locationSuccess &&
          !inlineVmActivity &&
          (!hasProgressOutcome || !options.progressVisible) &&
          message
            ? html`<div
                class="message message--${messageKind}"
                role=${messageKind === "error" ? "alert" : "status"}
              >
                ${message}${hasProgressOutcome && options.activity.kind !== "success"
                  ? html`<button class="button" data-action="show-progress">
                      ${t("platformClaw.execution.progressReopen")}
                    </button>`
                  : nothing}
              </div>`
            : nothing}
          <fieldset class="settings-content" ?disabled=${options.busy || options.loading}>
            ${options.activeTab === "location" && options.settings
              ? renderExecutionLocation({
                  settings: options.settings,
                  busy: options.busy || options.loading,
                  editingVm: options.editingVm,
                  vmDraft: options.vmDraft,
                  activity: options.activity,
                  progressVisible: options.progressVisible,
                })
              : unsafeHTML(options.bodyMarkup)}
          </fieldset>
        </main>
        <footer data-confirmation-footer aria-live="polite" ?hidden=${!options.pendingRelease}>
          ${options.pendingRelease
            ? html`<section class="confirm">
                <h3>${t("platformClaw.execution.releaseConfirmTitle")}</h3>
                <p>${t("platformClaw.execution.releaseConfirmBody")}</p>
                <div class="row">
                  <button class="button primary" data-action="confirm-release">
                    ${t("platformClaw.execution.releaseConfirm")}</button
                  ><button class="button" data-action="cancel-release">
                    ${t("platformClaw.execution.cancel")}
                  </button>
                </div>
              </section>`
            : nothing}
        </footer>
      </section>
    </openclaw-modal-dialog>
    <openclaw-modal-dialog
      data-progress-modal
      class="progress-modal"
      .open=${options.opened && options.progressVisible}
      .label=${t(
        isCredentialProgress(options.activity)
          ? "platformClaw.execution.vmConnection"
          : "platformClaw.execution.progressTitle",
      )}
    >
      ${renderProgressPanel(options, message)}
    </openclaw-modal-dialog>`;
}
