import { html, nothing } from "lit";
import { renderHubTabs } from "../components/hub-tabs.ts";
import { icons } from "../components/icons.ts";
import { i18n } from "../i18n/index.ts";
import { platformClawStatus, platformClawT as t } from "./i18n.ts";
import {
  vmAdminStageLabel,
  type VmAdminDialogViewOptions,
} from "./vm-administration-dialog-view.ts";
import {
  type VmAdminEndpoint,
  type VmAdminHost,
  type VmAdminMutation,
  type VmAdminTab,
  vmHostEditBlock,
  vmMutationBlock,
} from "./vm-administration-model.ts";
export { renderVmAdministrationDialog } from "./vm-administration-dialog-view.ts";

const copy = (key: string, params?: Record<string, string>) =>
  t(`platformClaw.vmAdmin.${key}`, params);

export type VmAdminViewOptions = VmAdminDialogViewOptions & {
  tab: VmAdminTab;
  loading: boolean;
  pageError: string;
  onTab: (tab: VmAdminTab) => void;
  onRefresh: () => void;
  onHost: (host?: VmAdminHost) => void;
  onEndpoint: (endpoint?: VmAdminEndpoint) => void;
  onRenameEndpoint: (endpoint: VmAdminEndpoint) => void;
  onEnvironment: (host: VmAdminHost) => void;
  onMutation: (mutation: VmAdminMutation) => void;
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
    "revoke-saved-connection": "revokeAllocation",
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
                      data-rename-endpoint=${endpoint.id}
                      ?disabled=${options.busy}
                      @click=${() => options.onRenameEndpoint(endpoint)}
                    >
                      ${copy("renameEndpoint")}
                    </button>
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
      ${options.snapshot?.savedConnections
        ?.filter((connection) => !connection.active)
        .map(
          (connection) => html`<article class="server-card" data-saved-connection=${connection.id}>
            <span class="server-glyph" aria-hidden="true">${icons.users}</span>
            <div class="server-info">
              <div class="card-top">
                <h3>${connection.accountId}</h3>
                <span class="badge" data-status=${connection.status}
                  >${t(
                    connection.status === "ready"
                      ? "platformClaw.execution.connectionReady"
                      : connection.status === "unavailable"
                        ? "platformClaw.execution.connectionUnavailable"
                        : "platformClaw.execution.reauthenticationRequired",
                  )}</span
                >
              </div>
              <p>${connection.vmLabel}</p>
              <p class="address muted">${connection.linuxAccount}</p>
              <div class="actions">
                ${mutationButton(options, {
                  action: "revoke-saved-connection",
                  fieldName: "connectionId",
                  id: connection.id,
                  label: `${connection.accountId} · ${connection.vmLabel}`,
                })}
              </div>
            </div>
          </article>`,
        )}
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
        : options.snapshot?.savedConnections?.length
          ? nothing
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
            ? vmAdminStageLabel(options.operation.stage)
            : options.operation.kind === "success"
              ? copy(options.operation.stage === "rename-endpoint" ? "endpointRenamed" : "saved")
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
