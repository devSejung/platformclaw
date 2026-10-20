import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { renderHubTabs } from "../components/hub-tabs.ts";
import { icons } from "../components/icons.ts";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
import { i18n } from "../i18n/index.ts";
import { platformClawStatus, platformClawT as t } from "./i18n.ts";
import {
  type VmAdminDialog,
  type VmAdminEndpoint,
  type VmAdminHost,
  type VmAdminMutation,
  type VmAdminOperation,
  type VmAdminSnapshot,
  type VmAdminStage,
  type VmAdminTab,
  type VmEnvironmentDraft,
  vmHostEditBlock,
  vmMutationBlock,
} from "./vm-administration-model.ts";

const copy = (key: string, params?: Record<string, string>) =>
  t(`platformClaw.vmAdmin.${key}`, params);
const stageKeys: Record<VmAdminStage, string> = {
  probe: "stageProbe",
  "save-endpoint": "stageSaveEndpoint",
  "recover-endpoint": "stageRecoverEndpoint",
  "approve-key": "stageApproveKey",
  "save-host": "stageSaveHost",
  "save-environment": "stageSaveEnvironment",
  "change-status": "stageChangeStatus",
};

export type VmAdminViewOptions = {
  snapshot: VmAdminSnapshot | null;
  tab: VmAdminTab;
  loading: boolean;
  busy: boolean;
  pageError: string;
  dialog: VmAdminDialog | null;
  operation: VmAdminOperation;
  dialogVisible: boolean;
  returnFocus: HTMLElement | null;
  onTab: (tab: VmAdminTab) => void;
  onRefresh: () => void;
  onHost: (host?: VmAdminHost) => void;
  onEndpoint: (endpoint?: VmAdminEndpoint) => void;
  onEnvironment: (host: VmAdminHost) => void;
  onMutation: (mutation: VmAdminMutation) => void;
  onInput: (event: Event) => void;
  onSubmit: (event: SubmitEvent) => void;
  onApprove: () => void;
  onBack: () => void;
  onClose: () => void;
  onShow: () => void;
};

function status(value: string, catalog = false) {
  const label = catalog
    ? copy(value === "active" ? "enabled" : value === "pending" ? "pendingApproval" : "disabled")
    : platformClawStatus(value);
  return html`<span class="badge" data-status=${value}>${label}</span>`;
}

function mutationButton(options: VmAdminViewOptions, mutation: VmAdminMutation) {
  const block = options.snapshot ? vmMutationBlock(options.snapshot, mutation) : null;
  const labelKeys = {
    "disable-endpoint": "disableEndpoint",
    "enable-endpoint": "enableEndpoint",
    "disable-host": "disableHost",
    "enable-host": "enableHost",
    "revoke-allocation": "revokeAllocation",
  };
  return html`<button
      type="button"
      data-mutation=${mutation.action}
      data-id=${mutation.id}
      data-field=${mutation.fieldName}
      ?disabled=${options.busy || Boolean(block)}
      title=${block ? copy(block) : ""}
      @click=${() => options.onMutation(mutation)}
    >
      ${copy(labelKeys[mutation.action])}</button
    >${block ? html`<p class="muted small">${copy(block)}</p>` : nothing}`;
}

function renderHosts(options: VmAdminViewOptions) {
  const snapshot = options.snapshot;
  return html`<section class="section">
    <div class="section-heading">
      <div>
        <h2>${copy("hosts")}</h2>
        <p class="muted small">${copy("hostsHelp")}</p>
      </div>
      <button
        class="primary"
        data-add-host
        ?disabled=${options.busy ||
        !snapshot?.endpoints.some((endpoint) => endpoint.status === "active")}
        @click=${() => options.onHost()}
      >
        ${copy("createHost")}
      </button>
    </div>
    ${!snapshot?.endpoints.some((endpoint) => endpoint.status === "active")
      ? html`<p class="muted small">${copy("noEnabledEndpoint")}</p>`
      : nothing}
    <div class="catalog">
      ${snapshot?.hosts.length
        ? snapshot.hosts.map((host) => {
            const endpoint = snapshot.endpoints.find(
              (candidate) => candidate.id === host.endpointId,
            );
            const block = vmHostEditBlock(snapshot, host);
            return html`<article class="server-card" data-host-id=${host.id}>
              <span class="server-glyph" aria-hidden="true">${icons.server}</span>
              <div class="server-info">
                <div class="card-top">
                  <h3>${host.label}</h3>
                  ${status(host.status, true)}
                </div>
                <p class="address">${host.targetAddress}</p>
                <p class="muted small">
                  ${endpoint
                    ? `${endpoint.label} · ${endpoint.host}:${endpoint.port}`
                    : copy("endpointUnavailable")}
                </p>
                <div class="actions">
                  <button
                    data-edit-environment=${host.id}
                    ?disabled=${options.busy}
                    @click=${() => options.onEnvironment(host)}
                  >
                    ${icons.settings}${copy("executionEnvironment")}</button
                  ><button
                    data-edit-host=${host.id}
                    ?disabled=${options.busy || Boolean(block)}
                    title=${block ? copy(block) : ""}
                    @click=${() => options.onHost(host)}
                  >
                    ${copy("edit")}</button
                  >${mutationButton(options, {
                    action: host.status === "active" ? "disable-host" : "enable-host",
                    fieldName: "vmHostId",
                    id: host.id,
                    label: host.label,
                  })}
                </div>
                ${block ? html`<p class="muted small">${copy(block)}</p>` : nothing}
              </div>
            </article>`;
          })
        : html`<div class="empty">
            ${icons.server}
            <p>${copy("noHosts")}</p>
          </div>`}
    </div>
  </section>`;
}

function renderEndpoints(options: VmAdminViewOptions) {
  return html`<section class="section">
    <div class="section-heading">
      <div>
        <h2>${copy("endpoints")}</h2>
        <p class="muted small">${copy("endpointHelp")}</p>
      </div>
      <button
        class="primary"
        data-add-endpoint
        ?disabled=${options.busy}
        @click=${() => options.onEndpoint()}
      >
        ${copy("createEndpoint")}
      </button>
    </div>
    <div class="catalog">
      ${options.snapshot?.endpoints.length
        ? options.snapshot.endpoints.map(
            (endpoint) =>
              html`<article class="server-card" data-endpoint-id=${endpoint.id}>
                <span class="server-glyph" aria-hidden="true">${icons.shieldCheck}</span>
                <div class="server-info">
                  <div class="card-top">
                    <h3>${endpoint.label}</h3>
                    ${status(endpoint.status, true)}
                  </div>
                  <p class="address">${endpoint.host}:${endpoint.port}</p>
                  <p class="muted small">${endpoint.adDomain}</p>
                  ${endpoint.hostKeyFingerprint
                    ? html`<p class="fingerprint muted">${endpoint.hostKeyFingerprint}</p>`
                    : nothing}
                  <div class="actions">
                    <button
                      data-edit-endpoint=${endpoint.id}
                      ?disabled=${options.busy || endpoint.status === "active"}
                      title=${endpoint.status === "active" ? copy("disableEndpointFirst") : ""}
                      @click=${() => options.onEndpoint(endpoint)}
                    >
                      ${copy("editAndVerify")}</button
                    >${endpoint.status === "active" || endpoint.hostKeyFingerprint
                      ? mutationButton(options, {
                          action:
                            endpoint.status === "active" ? "disable-endpoint" : "enable-endpoint",
                          fieldName: "endpointId",
                          id: endpoint.id,
                          label: endpoint.label,
                        })
                      : nothing}
                  </div>
                  ${endpoint.status === "active"
                    ? html`<p class="muted small">${copy("disableEndpointFirst")}</p>`
                    : nothing}
                </div>
              </article>`,
          )
        : html`<div class="empty">
            ${icons.shieldCheck}
            <p>${copy("noEndpoints")}</p>
          </div>`}
    </div>
  </section>`;
}

function renderAllocations(options: VmAdminViewOptions) {
  return html`<section class="section">
    <div class="section-heading">
      <div>
        <h2>${copy("allocations")}</h2>
        <p class="muted small">${copy("allocationHelp")}</p>
      </div>
    </div>
    <div class="catalog">
      ${options.snapshot?.allocations.length
        ? options.snapshot.allocations.map(
            (allocation) =>
              html`<article class="server-card">
                <span class="server-glyph" aria-hidden="true">${icons.users}</span>
                <div class="server-info">
                  <div class="card-top">
                    <h3>${allocation.displayName ?? allocation.accountId}</h3>
                    ${status(allocation.status)}
                  </div>
                  <p>${allocation.vmLabel}</p>
                  <p class="address muted">${allocation.linuxAccount}</p>
                  ${allocation.status !== "revoked"
                    ? html`<div class="actions">
                        ${mutationButton(options, {
                          action: "revoke-allocation",
                          fieldName: "allocationId",
                          id: allocation.id,
                          label: allocation.displayName ?? allocation.accountId,
                        })}
                      </div>`
                    : nothing}
                </div>
              </article>`,
          )
        : html`<div class="empty">${copy("noAllocations")}</div>`}
    </div>
  </section>`;
}

export function renderVmAdministrationPage(options: VmAdminViewOptions) {
  const snapshot = options.snapshot;
  const liveAllocations =
    snapshot?.allocations.filter((allocation) => allocation.status !== "revoked").length ?? 0;
  const tabs = [
    { id: "hosts", label: "hosts", count: snapshot?.hosts.length ?? 0 },
    { id: "endpoints", label: "endpoints", count: snapshot?.endpoints.length ?? 0 },
    { id: "allocations", label: "allocations", count: liveAllocations },
    { id: "audit", label: "activity", count: snapshot?.auditEvents.length ?? 0 },
  ] as const;
  return html`<main aria-busy=${String(options.loading)}>
    <section class="overview" aria-label=${copy("overview")}>
      <div class="metric">
        <strong
          >${snapshot
            ? snapshot.hosts.filter((host) => host.status === "active").length
            : "—"}</strong
        ><span>${copy("enabledHosts")}</span>
      </div>
      <div class="metric">
        <strong>${snapshot ? liveAllocations : "—"}</strong
        ><span>${copy("activeAllocations")}</span>
      </div>
      <div class="metric">
        <strong
          >${snapshot
            ? snapshot.endpoints.filter((endpoint) => endpoint.status === "active").length
            : "—"}</strong
        ><span>${copy("enabledEndpoints")}</span>
      </div>
    </section>
    <div class="toolbar">
      ${renderHubTabs({
        id: "admin",
        active: options.tab,
        tabs: tabs.map((tab) => ({ value: tab.id, label: copy(tab.label), count: tab.count })),
        ariaLabel: copy("sections"),
        panelId: "admin-panel",
        className: "tabs",
        onSelect: options.onTab,
      })}
      <button data-refresh ?disabled=${options.busy} @click=${options.onRefresh}>
        ${copy("refresh")}
      </button>
    </div>
    ${options.loading ? html`<p class="notice" role="status">${copy("loading")}</p>` : nothing}
    ${options.pageError
      ? html`<div class="notice" role="alert">
          ${options.pageError}<button ?disabled=${options.busy} @click=${options.onRefresh}>
            ${copy("refresh")}
          </button>
        </div>`
      : nothing}
    ${options.operation.kind !== "idle"
      ? html`<div
          class="notice"
          role=${options.operation.kind === "error" ? "alert" : "status"}
          ?data-success=${options.operation.kind === "success"}
        >
          ${options.operation.kind === "working"
            ? copy(stageKeys[options.operation.stage])
            : options.operation.kind === "success"
              ? copy("saved")
              : options.operation.kind === "review"
                ? copy("awaitingApproval")
                : options.operation.error}${options.dialog && !options.dialogVisible
            ? html`<button data-view-progress @click=${options.onShow}>
                ${copy("viewProgress")}
              </button>`
            : nothing}
        </div>`
      : nothing}
    <section
      id="admin-panel"
      role="tabpanel"
      aria-labelledby=${`admin-tab-${options.tab}`}
      tabindex="0"
    >
      ${options.tab === "hosts"
        ? renderHosts(options)
        : options.tab === "endpoints"
          ? renderEndpoints(options)
          : options.tab === "allocations"
            ? renderAllocations(options)
            : html`<section class="section">
                <h2>${copy("audit")}</h2>
                ${snapshot?.auditEvents.length
                  ? html`<ul class="audit">
                      ${snapshot.auditEvents.map(
                        (event) =>
                          html`<li>
                            <div>
                              <strong>${event.eventType}</strong>
                              <p class="muted small">${event.targetType}</p>
                            </div>
                            <time datetime=${new Date(event.createdAt).toISOString()}
                              >${new Date(event.createdAt).toLocaleString(i18n.getLocale())}</time
                            >
                          </li>`,
                      )}
                    </ul>`
                  : html`<div class="empty">${copy("noActivity")}</div>`}
              </section>`}
    </section>
  </main>`;
}

function vmAdminDialogTitle(dialog: VmAdminDialog | null): string {
  if (!dialog) {
    return copy("title");
  }
  return dialog.kind === "endpoint"
    ? copy(dialog.draft.endpointId ? "editAndVerify" : "createEndpoint")
    : dialog.kind === "environment"
      ? copy("executionEnvironment")
      : dialog.kind === "confirmation"
        ? copy("confirmTitle")
        : copy(dialog.hostId ? "edit" : "createHost");
}

function environmentFields(
  draft: VmEnvironmentDraft,
  onInput: (event: Event) => void,
): TemplateResult {
  return html`<p class="muted small">${copy("executionEnvironmentHelp")}</p>
    <label
      >${copy("pathPrepend")}<textarea
        name="pathPrepend"
        autofocus
        .value=${draft.pathPrepend}
        @input=${onInput}
        placeholder="/opt/toolchain/bin"
      ></textarea></label
    ><label
      >${copy("environmentVariables")}<textarea
        name="environmentVariables"
        .value=${draft.environmentVariables}
        @input=${onInput}
        placeholder="TOOLCHAIN_PREFIX=/opt/toolchain/bin/prefix-"
      ></textarea>
    </label>
    <p class="muted small">${copy("environmentVariablesHelp")}</p>`;
}

function renderProgress(operation: VmAdminOperation) {
  if (operation.kind === "idle" || operation.kind === "review") {
    return nothing;
  }
  return html`<div
    class="progress"
    data-admin-progress
    data-stage=${operation.stage}
    data-outcome=${operation.kind}
    role="status"
    aria-live="polite"
  >
    <div class="flow" aria-hidden="true">
      <span class="flow-server">${icons.server}${copy("administration")}</span
      ><span class="flow-link"
        ><span class="flow-track"></span><span class="flow-packet"></span
        ><span class="flow-orb"
          >${operation.kind === "working"
            ? html`<span class="spinner"></span>`
            : operation.kind === "success"
              ? icons.check
              : icons.x}</span
        ></span
      ><span class="flow-server"
        >${operation.stage === "probe" || operation.stage === "approve-key"
          ? icons.shieldCheck
          : icons.server}${copy(
          operation.stage === "probe" || operation.stage === "approve-key"
            ? "endpoint"
            : "configuration",
        )}</span
      >
    </div>
    <p>
      ${copy(
        operation.kind === "success"
          ? "saved"
          : operation.kind === "error"
            ? "operationFailed"
            : stageKeys[operation.stage],
      )}
    </p>
    ${operation.kind === "working" ? html`<p class="small">${copy("backgroundWork")}</p>` : nothing}
  </div>`;
}

function renderEditor(options: VmAdminViewOptions, dialog: VmAdminDialog) {
  const operation = options.operation;
  const workingOrSuccess = operation.kind === "working" || operation.kind === "success";
  if (dialog.kind === "confirmation") {
    return html`<section ?hidden=${workingOrSuccess}>
      <p>
        ${copy(
          dialog.mutation.action === "disable-endpoint"
            ? "confirmDisableEndpoint"
            : dialog.mutation.action === "disable-host"
              ? "confirmDisableHost"
              : dialog.mutation.action === "revoke-allocation"
                ? "confirmRevoke"
                : dialog.mutation.action === "enable-endpoint"
                  ? "confirmEnableEndpoint"
                  : "confirmEnableHost",
          { label: dialog.mutation.label },
        )}
      </p>
      <div class="dialog-footer">
        <button data-cancel-mutation @click=${options.onClose}>${copy("cancel")}</button
        ><button class="primary" data-confirm-mutation @click=${options.onApprove}>
          ${copy("confirm")}
        </button>
      </div>
    </section>`;
  }
  if (dialog.kind === "endpoint") {
    const reviewing = Boolean(dialog.probe);
    return html`<form
        data-endpoint-probe
        ?hidden=${workingOrSuccess || reviewing}
        @submit=${options.onSubmit}
      >
        <fieldset ?disabled=${options.busy}>
          <input type="hidden" name="endpointId" .value=${dialog.draft.endpointId ?? ""} /><label
            >${copy("label")}<input
              name="label"
              .value=${dialog.draft.label}
              @input=${options.onInput}
              required
              autofocus /></label
          ><label
            >${copy("endpointHost")}<input
              name="host"
              .value=${dialog.draft.host}
              @input=${options.onInput}
              required /></label
          ><label
            >${copy("port")}<input
              name="port"
              type="number"
              min="1"
              max="65535"
              .value=${String(dialog.draft.port)}
              @input=${options.onInput}
              required /></label
          ><label
            >${copy("adDomain")}<input
              name="adDomain"
              .value=${dialog.draft.adDomain}
              @input=${options.onInput}
              required
          /></label>
          <p class="muted small">${copy("endpointHelp")}</p>
          <div class="dialog-footer">
            <button type="button" data-cancel-probe @click=${options.onClose}>
              ${copy("cancel")}</button
            ><button class="primary">${copy("probeBeforeSave")}</button>
          </div>
        </fieldset>
      </form>
      ${dialog.probe
        ? html`<section class="probe-facts" ?hidden=${workingOrSuccess}>
            <h3>${copy("verifyHostKey")}</h3>
            <p class="muted small">${copy("hostKeyTargetHelp")}</p>
            <dl>
              <dt>${copy("endpointHost")}</dt>
              <dd>${dialog.probe.host}:${dialog.probe.port}</dd>
              <dt>DNS</dt>
              <dd>${dialog.probe.resolvedAddresses.join(", ")}</dd>
              <dt>SSH</dt>
              <dd>${dialog.probe.sshBanner}</dd>
              <dt>${copy("fingerprint")}</dt>
              <dd class="fingerprint">${dialog.probe.fingerprint}</dd>
            </dl>
            <p class="muted small">${copy("keyCommentHelp")}</p>
            <div class="dialog-footer">
              <button data-cancel-probe @click=${options.onClose}>${copy("cancel")}</button
              ><button data-back-to-form @click=${options.onBack}>${copy("edit")}</button
              ><button class="primary" data-approve-probe @click=${options.onApprove}>
                ${copy("approveAndSave")}
              </button>
            </div>
          </section>`
        : nothing}`;
  }
  const environment = dialog.kind === "environment";
  const draft = dialog.draft;
  return html`<form
    data-action=${environment
      ? "update-host-execution-environment"
      : dialog.hostId
        ? "update-host"
        : "hosts"}
    ?hidden=${workingOrSuccess}
    @submit=${options.onSubmit}
  >
    <fieldset ?disabled=${options.busy}>
      ${environment
        ? html`<input type="hidden" name="vmHostId" .value=${dialog.host.id} />${environmentFields(
              draft,
              options.onInput,
            )}`
        : html`<input type="hidden" name="vmHostId" .value=${dialog.hostId ?? ""} /><label
              >${copy("vmLabel")}<input
                name="label"
                .value=${dialog.draft.label}
                @input=${options.onInput}
                required
                autofocus /></label
            ><label
              >${copy("targetAddress")}<input
                name="targetAddress"
                .value=${dialog.draft.targetAddress}
                @input=${options.onInput}
                required /></label
            ><label
              >${copy("endpoint")}<select
                name="endpointId"
                .value=${dialog.draft.endpointId}
                @change=${options.onInput}
                required
              >
                <option value="" ?selected=${!dialog.draft.endpointId} disabled>
                  ${copy("chooseEndpoint")}
                </option>
                ${options.snapshot?.endpoints
                  .filter((endpoint) => endpoint.status === "active")
                  .map(
                    (endpoint) =>
                      html`<option
                        value=${endpoint.id}
                        ?selected=${endpoint.id === dialog.draft.endpointId}
                      >
                        ${endpoint.label}
                      </option>`,
                  )}
              </select></label
            >${!dialog.hostId
              ? html`<details>
                  <summary>${copy("optionalEnvironment")}</summary>
                  <div>${environmentFields(dialog.draft, options.onInput)}</div>
                </details>`
              : nothing}`}
      <div class="dialog-footer">
        <button type="button" data-close-admin @click=${options.onClose}>${copy("cancel")}</button
        ><button class="primary">
          ${copy(environment ? "saveEnvironment" : dialog.hostId ? "saveChanges" : "createHost")}
        </button>
      </div>
    </fieldset>
  </form>`;
}

export function renderVmAdministrationDialog(options: VmAdminViewOptions) {
  const dialog = options.dialog;
  return html`<openclaw-modal-dialog
    class="admin-modal palette"
    data-admin-modal
    .open=${Boolean(dialog && options.dialogVisible)}
    .label=${vmAdminDialogTitle(dialog)}
    ${ref((element) =>
      (element as OpenClawModalDialog | undefined)?.setReturnFocusTarget(options.returnFocus),
    )}
    @modal-cancel=${options.onClose}
  >
    ${dialog
      ? html`<section class="admin-dialog" data-operation-phase=${options.operation.kind}>
          <header class="dialog-heading">
            <div>
              <h2>${vmAdminDialogTitle(dialog)}</h2>
              ${dialog.kind === "environment" ? html`<p>${dialog.host.label}</p>` : nothing}
            </div>
            <button
              class="dialog-close"
              type="button"
              data-close-admin
              aria-label=${copy("close")}
              @click=${options.onClose}
            >
              ×
            </button>
          </header>
          ${renderProgress(options.operation)}${options.operation.kind === "error"
            ? html`<div class="form-error" role="alert" tabindex="-1">
                ${options.operation.error}
                <p class="small">${copy("retryHelp")}</p>
              </div>`
            : nothing}${renderEditor(options, dialog)}
        </section>`
      : nothing}
  </openclaw-modal-dialog>`;
}
