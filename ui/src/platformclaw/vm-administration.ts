import "../components/modal-dialog.ts";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale, platformClawStatus, platformClawT as t } from "./i18n.ts";
import { PLATFORMCLAW_VM_ADMIN_API_PATH } from "./web-contract.ts";

type Endpoint = {
  id: string;
  label: string;
  host: string;
  port: number;
  adDomain: string;
  status: "pending" | "active" | "disabled";
  hostKeyFingerprint?: string;
};
type VmHost = {
  id: string;
  endpointId: string;
  label: string;
  targetAddress: string;
  status: "active" | "disabled";
  executionEnvironment?: {
    pathPrepend: string[];
    variables: Record<string, string>;
  };
};
type Agent = {
  accountId: string;
  agentId: string;
  displayName?: string;
  department?: string;
  allocationId?: string;
};
type Allocation = {
  id: string;
  accountId: string;
  displayName?: string;
  vmLabel: string;
  linuxAccount: string;
  status: "assigned" | "ready" | "connection_required" | "revoked";
};
type AuditEvent = {
  id: string;
  eventType: string;
  targetType: string;
  targetId: string;
  createdAt: number;
};
type VmAdministrationSnapshot = {
  endpoints: Endpoint[];
  hosts: VmHost[];
  agents: Agent[];
  allocations: Allocation[];
  auditEvents: AuditEvent[];
  probe?: SafeConnectProbe;
};

type SafeConnectProbe = {
  host: string;
  port: number;
  resolvedAddresses: string[];
  sshBanner: string;
  algorithm: "ssh-ed25519";
  publicKey: string;
  fingerprint: string;
};

type EndpointDraft = {
  endpointId?: string;
  persisted?: boolean;
  label: string;
  host: string;
  port: number;
  adDomain: string;
};

type PendingMutation = {
  action:
    | "disable-endpoint"
    | "enable-endpoint"
    | "disable-host"
    | "enable-host"
    | "revoke-allocation";
  fieldName: "endpointId" | "vmHostId" | "allocationId";
  id: string;
  label: string;
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ??
      character,
  );
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function executionEnvironment(form: FormData): VmHost["executionEnvironment"] {
  const pathPrepend = field(form, "pathPrepend")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const variables = Object.fromEntries(
    field(form, "environmentVariables")
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 1
          ? [line, ""]
          : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
  );
  return { pathPrepend, variables };
}

class VmAdministrationHttpError extends Error {}

class PlatformClawVmAdministrationElement extends HTMLElement {
  private readonly root = this.attachShadow({ mode: "open" });
  private snapshot: VmAdministrationSnapshot | null = null;
  private opened = false;
  private loading = false;
  private message = "";
  private pendingMutation: PendingMutation | null = null;
  private endpointDraft: EndpointDraft | null = null;
  private probe: SafeConnectProbe | null = null;
  private unsubscribeLocale = () => {};

  declare fetchImpl: typeof fetch;
  declare onUnauthenticated: () => void;

  constructor() {
    super();
    this.fetchImpl ??= globalThis.fetch.bind(globalThis);
    this.onUnauthenticated ??= () => {};
  }

  connectedCallback(): void {
    this.unsubscribeLocale = i18n.subscribe(() => void this.renderLocale());
    void this.renderLocale();
  }

  disconnectedCallback(): void {
    this.unsubscribeLocale();
  }

  private async renderLocale(): Promise<void> {
    await loadPlatformClawLocale();
    if (this.isConnected) {
      this.render();
    }
  }

  private async request(init?: RequestInit): Promise<VmAdministrationSnapshot> {
    const response = await this.fetchImpl(PLATFORMCLAW_VM_ADMIN_API_PATH, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...init,
    });
    if (response.status === 401) {
      this.onUnauthenticated();
      throw new VmAdministrationHttpError(t("platformClaw.execution.sessionExpired"));
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new VmAdministrationHttpError(
        typeof body.error === "string" ? body.error : t("platformClaw.vmAdmin.requestFailed"),
      );
    }
    return body as VmAdministrationSnapshot;
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      this.snapshot = await this.request();
      this.message = "";
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.vmAdmin.requestFailed");
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async mutate(body: Record<string, unknown>): Promise<void> {
    this.loading = true;
    this.render();
    try {
      this.snapshot = await this.request({ method: "POST", body: JSON.stringify(body) });
      this.message = t("platformClaw.vmAdmin.saved");
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.vmAdmin.requestFailed");
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async probeEndpoint(draft: EndpointDraft): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const response = await this.request({
        method: "POST",
        body: JSON.stringify({ action: "probe-endpoint", host: draft.host, port: draft.port }),
      });
      this.snapshot = response;
      this.endpointDraft = draft;
      this.probe = response.probe ?? null;
      this.message = this.probe ? t("platformClaw.vmAdmin.probeSucceeded") : "";
    } catch (error) {
      this.endpointDraft = null;
      this.probe = null;
      this.message =
        error instanceof Error ? error.message : t("platformClaw.vmAdmin.requestFailed");
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async approveProbedEndpoint(): Promise<void> {
    const draft = this.endpointDraft;
    const probe = this.probe;
    if (!draft || !probe) {
      return;
    }
    this.loading = true;
    this.render();
    try {
      let endpointId = draft.endpointId;
      if (endpointId && !draft.persisted) {
        this.snapshot = await this.request({
          method: "POST",
          body: JSON.stringify({ action: "update-endpoint", ...draft }),
        });
      } else if (!endpointId) {
        const findCreatedEndpoint = (snapshot: VmAdministrationSnapshot) =>
          snapshot.endpoints.find(
            (endpoint) => endpoint.host === probe.host && endpoint.port === probe.port,
          )?.id;
        try {
          this.snapshot = await this.request({
            method: "POST",
            body: JSON.stringify({ action: "endpoints", ...draft }),
          });
          endpointId = findCreatedEndpoint(this.snapshot);
        } catch (createError) {
          if (createError instanceof VmAdministrationHttpError) {
            throw createError;
          }
          try {
            this.snapshot = await this.request();
            endpointId = findCreatedEndpoint(this.snapshot);
          } catch {
            throw createError;
          }
          if (!endpointId) {
            throw createError;
          }
        }
      }
      if (!endpointId) {
        throw new Error(t("platformClaw.vmAdmin.requestFailed"));
      }
      this.endpointDraft = { ...draft, endpointId, persisted: true };
      this.snapshot = await this.request({
        method: "POST",
        body: JSON.stringify({
          action: "host-key",
          endpointId,
          algorithm: probe.algorithm,
          publicKey: probe.publicKey,
          fingerprint: probe.fingerprint,
        }),
      });
      this.endpointDraft = null;
      this.probe = null;
      this.message = t("platformClaw.vmAdmin.saved");
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.vmAdmin.requestFailed");
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private bindForm(action: string, mapper: (form: FormData) => Record<string, unknown>): void {
    this.root
      .querySelector<HTMLFormElement>(`form[data-action='${action}']`)
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.mutate({
          action,
          ...mapper(new FormData(event.currentTarget as HTMLFormElement)),
        });
      });
  }

  private bindEvents(): void {
    const closeDialog = () => {
      this.opened = false;
      this.render();
    };
    this.root.querySelector("[data-open]")?.addEventListener("click", () => {
      this.opened = true;
      void this.refresh();
    });
    this.root.querySelector("[data-close]")?.addEventListener("click", closeDialog);
    this.root.querySelector("openclaw-modal-dialog")?.addEventListener("modal-cancel", closeDialog);
    this.root.querySelector("[data-refresh]")?.addEventListener("click", () => void this.refresh());
    for (const form of this.root.querySelectorAll<HTMLFormElement>("form[data-endpoint-probe]")) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const data = new FormData(form);
        void this.probeEndpoint({
          ...(field(data, "endpointId") ? { endpointId: field(data, "endpointId") } : {}),
          label: field(data, "label"),
          host: field(data, "host"),
          port: Number(field(data, "port")),
          adDomain: field(data, "adDomain"),
        });
      });
    }
    this.root.querySelector("[data-approve-probe]")?.addEventListener("click", () => {
      void this.approveProbedEndpoint();
    });
    this.root.querySelector("[data-cancel-probe]")?.addEventListener("click", () => {
      this.endpointDraft = null;
      this.probe = null;
      this.render();
    });
    this.bindForm("update-host", (form) => ({
      vmHostId: field(form, "vmHostId"),
      endpointId: field(form, "endpointId"),
      label: field(form, "label"),
      targetAddress: field(form, "targetAddress"),
    }));
    this.bindForm("update-host-execution-environment", (form) => ({
      vmHostId: field(form, "vmHostId"),
      executionEnvironment: executionEnvironment(form),
    }));
    this.bindForm("hosts", (form) => ({
      endpointId: field(form, "endpointId"),
      label: field(form, "label"),
      targetAddress: field(form, "targetAddress"),
      executionEnvironment: executionEnvironment(form),
    }));
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-mutation]")) {
      button.addEventListener("click", () => {
        const action = button.dataset.mutation;
        const fieldName = button.dataset.field;
        const value = button.dataset.id;
        const label = button.dataset.label;
        if (
          (action === "disable-endpoint" ||
            action === "enable-endpoint" ||
            action === "disable-host" ||
            action === "enable-host" ||
            action === "revoke-allocation") &&
          (fieldName === "endpointId" ||
            fieldName === "vmHostId" ||
            fieldName === "allocationId") &&
          value &&
          label
        ) {
          this.pendingMutation = { action, fieldName, id: value, label };
          this.render();
        }
      });
    }
    this.root.querySelector("[data-cancel-mutation]")?.addEventListener("click", () => {
      this.pendingMutation = null;
      this.render();
    });
    this.root.querySelector("[data-confirm-mutation]")?.addEventListener("click", () => {
      const pending = this.pendingMutation;
      if (pending) {
        this.pendingMutation = null;
        void this.mutate({ action: pending.action, [pending.fieldName]: pending.id });
      }
    });
  }

  private options(
    values: ReadonlyArray<{ id: string; label: string }>,
    selectedId?: string,
  ): string {
    return values
      .map(
        (value) =>
          `<option value="${escapeHtml(value.id)}"${value.id === selectedId ? " selected" : ""}>${escapeHtml(value.label)}</option>`,
      )
      .join("");
  }

  private executionEnvironmentFields(host?: VmHost): string {
    const pathPrepend = host?.executionEnvironment?.pathPrepend.join("\n") ?? "";
    const variables = Object.entries(host?.executionEnvironment?.variables ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join("\n");
    return `<p class="muted">${escapeHtml(t("platformClaw.vmAdmin.executionEnvironmentHelp"))}</p><label>${escapeHtml(t("platformClaw.vmAdmin.pathPrepend"))}<textarea name="pathPrepend" placeholder="/opt/toolchain/bin">${escapeHtml(pathPrepend)}</textarea></label><label>${escapeHtml(t("platformClaw.vmAdmin.environmentVariables"))}<textarea name="environmentVariables" placeholder="TOOLCHAIN_PREFIX=/opt/toolchain/bin/prefix-">${escapeHtml(variables)}</textarea></label><p class="muted">${escapeHtml(t("platformClaw.vmAdmin.environmentVariablesHelp"))}</p>`;
  }

  private render(): void {
    const data = this.snapshot;
    const activeEndpoints =
      data?.endpoints.filter((endpoint) => endpoint.status === "active") ?? [];
    const activeEndpointIds = new Set(activeEndpoints.map((endpoint) => endpoint.id));
    const rows = (values: string[]) =>
      values.length > 0
        ? `<ul>${values.map((value) => `<li>${value}</li>`).join("")}</ul>`
        : `<p class="muted">${escapeHtml(t("platformClaw.vmAdmin.noItems"))}</p>`;
    this.root.innerHTML = `
      <style>
        :host { display: block; color: var(--text); font: 13px/1.45 var(--font-sans, system-ui, sans-serif); }
        button, input, select, textarea { font: inherit; }
        .open { box-sizing: border-box; width: 100%; min-height: 34px; padding: 7px 9px; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--muted-strong); cursor: pointer; text-align: left; transition: background var(--duration-fast) ease, color var(--duration-fast) ease; }
        .open:hover, .open:focus-visible { background: var(--bg-hover); color: var(--text); outline: none; }
        .modal { --openclaw-modal-width: min(1040px, calc(100vw - 48px)); --openclaw-modal-max-height: min(860px, calc(100dvh - 48px)); }
        .dialog { width: min(1040px, 100%); max-height: min(860px, calc(100vh - 48px)); overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--bg); color: var(--text); box-shadow: var(--shadow-xl); }
        header { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; gap: 16px; padding: 18px 22px; border-bottom: 1px solid var(--border); background: var(--bg-elevated); }
        h2, h3 { margin: 0; } main { display: grid; gap: 16px; padding: 20px; } .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .card { padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); } form { display: grid; gap: 10px; margin-top: 14px; } label { display: grid; gap: 5px; color: var(--muted-strong); }
        input, select, textarea { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg-elevated); color: var(--text); } textarea { min-height: 72px; resize: vertical; }
        input:focus, select:focus, textarea:focus { border-color: var(--accent); outline: none; box-shadow: var(--focus-ring); }
        button { padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg-elevated); color: var(--text); cursor: pointer; } button:hover:not(:disabled), button:focus-visible { background: var(--bg-hover); border-color: var(--border-hover); outline: none; } button.primary { background: var(--accent); color: var(--accent-foreground); border-color: var(--accent); } button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); } button:disabled { opacity: .5; cursor: not-allowed; }
        ul { display: grid; gap: 8px; padding: 0; list-style: none; } li { padding: 9px 10px; border-radius: var(--radius-md); background: var(--bg-muted); } .muted { color: var(--muted); } .message { padding: 10px; border-radius: var(--radius-md); background: var(--accent-subtle); } .actions { display: flex; gap: 8px; margin-top: 8px; } details { margin-top: 8px; } summary { cursor: pointer; color: var(--muted-strong); } dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; } dt { color: var(--muted); } dd { margin: 0; min-width: 0; overflow-wrap: anywhere; } code { font-family: var(--font-mono, monospace); }
        @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } .modal { --openclaw-modal-width: calc(100vw - 16px); --openclaw-modal-max-height: calc(100dvh - 16px); } }
      </style>
      <button class="open" data-open>${escapeHtml(t("platformClaw.vmAdmin.open"))}</button>
      ${
        this.opened
          ? `<openclaw-modal-dialog class="modal" label="${escapeHtml(t("platformClaw.vmAdmin.title"))}"><section class="dialog">
            <header><div><h2>${escapeHtml(t("platformClaw.vmAdmin.title"))}</h2><div class="muted">${escapeHtml(t("platformClaw.vmAdmin.intro"))}</div></div><button data-close aria-label="${escapeHtml(t("platformClaw.vmAdmin.close"))}">×</button></header>
            <main>${this.loading ? `<p>${escapeHtml(t("platformClaw.vmAdmin.loading"))}</p>` : ""}${this.message ? `<div class="message">${escapeHtml(this.message)}</div>` : ""}
              <div class="grid">
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.endpoints"))}</h3><p class="muted">${escapeHtml(t("platformClaw.vmAdmin.endpointHelp"))}</p>${rows(data?.endpoints.map((endpoint) => `<strong>${escapeHtml(endpoint.label)}</strong> · ${escapeHtml(endpoint.host)}:${endpoint.port} · ${escapeHtml(platformClawStatus(endpoint.status))}${endpoint.hostKeyFingerprint ? `<br><small>${escapeHtml(endpoint.hostKeyFingerprint)}</small>` : ""}<div class="actions">${endpoint.status === "active" ? `<button type="button" data-mutation="disable-endpoint" data-field="endpointId" data-id="${escapeHtml(endpoint.id)}" data-label="${escapeHtml(endpoint.label)}">${escapeHtml(t("platformClaw.vmAdmin.disableEndpoint"))}</button>` : endpoint.hostKeyFingerprint ? `<button type="button" data-mutation="enable-endpoint" data-field="endpointId" data-id="${escapeHtml(endpoint.id)}" data-label="${escapeHtml(endpoint.label)}">${escapeHtml(t("platformClaw.vmAdmin.enableEndpoint"))}</button>` : ""}</div>${endpoint.status !== "active" ? `<details><summary>${escapeHtml(t("platformClaw.vmAdmin.editAndVerify"))}</summary><form data-endpoint-probe><input type="hidden" name="endpointId" value="${escapeHtml(endpoint.id)}"><label>${escapeHtml(t("platformClaw.vmAdmin.label"))}<input name="label" value="${escapeHtml(endpoint.label)}" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.endpointHost"))}<input name="host" value="${escapeHtml(endpoint.host)}" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.port"))}<input name="port" type="number" min="1" max="65535" value="${endpoint.port}" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.adDomain"))}<input name="adDomain" value="${escapeHtml(endpoint.adDomain)}" required></label><button class="primary">${escapeHtml(t("platformClaw.vmAdmin.probeEndpoint"))}</button></form></details>` : ""}`) ?? [])}
                  <form data-endpoint-probe><label>${escapeHtml(t("platformClaw.vmAdmin.label"))}<input name="label" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.endpointHost"))}<input name="host" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.port"))}<input name="port" type="number" min="1" max="65535" value="44422" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.adDomain"))}<input name="adDomain" required></label><button class="primary">${escapeHtml(t("platformClaw.vmAdmin.probeBeforeSave"))}</button></form>
                </section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.hosts"))}</h3>${rows(data?.hosts.map((host) => `<strong>${escapeHtml(host.label)}</strong> · ${escapeHtml(host.targetAddress)} · ${escapeHtml(platformClawStatus(host.status))}<div class="actions"><button type="button" data-mutation="${host.status === "active" ? "disable-host" : "enable-host"}" data-field="vmHostId" data-id="${escapeHtml(host.id)}" data-label="${escapeHtml(host.label)}"${host.status === "disabled" && !activeEndpointIds.has(host.endpointId) ? " disabled" : ""}>${escapeHtml(t(host.status === "active" ? "platformClaw.vmAdmin.disableHost" : "platformClaw.vmAdmin.enableHost"))}</button></div><details><summary>${escapeHtml(t("platformClaw.vmAdmin.executionEnvironment"))}</summary><form data-action="update-host-execution-environment"><input type="hidden" name="vmHostId" value="${escapeHtml(host.id)}">${this.executionEnvironmentFields(host)}<button class="primary">${escapeHtml(t("platformClaw.vmAdmin.saveEnvironment"))}</button></form></details>${host.status === "disabled" ? (activeEndpointIds.has(host.endpointId) ? `<details><summary>${escapeHtml(t("platformClaw.vmAdmin.edit"))}</summary><form data-action="update-host"><input type="hidden" name="vmHostId" value="${escapeHtml(host.id)}"><label>${escapeHtml(t("platformClaw.vmAdmin.endpoint"))}<select name="endpointId">${this.options(activeEndpoints, host.endpointId)}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.vmLabel"))}<input name="label" value="${escapeHtml(host.label)}" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.targetAddress"))}<input name="targetAddress" value="${escapeHtml(host.targetAddress)}" required></label><button class="primary">${escapeHtml(t("platformClaw.vmAdmin.saveChanges"))}</button></form></details>` : `<p class="muted">${escapeHtml(t("platformClaw.vmAdmin.hostEditRequiresActiveEndpoint"))}</p>`) : ""}`) ?? [])}
                  <form data-action="hosts"><label>${escapeHtml(t("platformClaw.vmAdmin.endpoint"))}<select name="endpointId" ${activeEndpoints.length ? "" : "disabled"}>${this.options(activeEndpoints)}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.vmLabel"))}<input name="label" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.targetAddress"))}<input name="targetAddress" required></label>${this.executionEnvironmentFields()}<button class="primary" ${activeEndpoints.length ? "" : "disabled"}>${escapeHtml(t("platformClaw.vmAdmin.createHost"))}</button></form>
                </section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.allocations"))}</h3><p class="muted">${escapeHtml(t("platformClaw.vmAdmin.allocationHelp"))}</p>${rows(data?.allocations.map((allocation) => `<strong>${escapeHtml(allocation.displayName ?? allocation.accountId)}</strong> · ${escapeHtml(allocation.vmLabel)} · ${escapeHtml(allocation.linuxAccount)} · ${escapeHtml(platformClawStatus(allocation.status))}<br><button type="button" data-mutation="revoke-allocation" data-field="allocationId" data-id="${escapeHtml(allocation.id)}" data-label="${escapeHtml(allocation.displayName ?? allocation.accountId)}">${escapeHtml(t("platformClaw.vmAdmin.revokeAllocation"))}</button>`) ?? [])}</section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.audit"))}</h3>${rows(data?.auditEvents.map((event) => `<strong>${escapeHtml(event.eventType)}</strong> · ${escapeHtml(event.targetType)} · ${escapeHtml(new Date(event.createdAt).toLocaleString())}`) ?? [])}</section>
              </div>${this.probe ? `<section class="card probe"><h3>${escapeHtml(t("platformClaw.vmAdmin.verifyHostKey"))}</h3><p>${escapeHtml(t("platformClaw.vmAdmin.hostKeyTargetHelp"))}</p><dl><dt>DNS</dt><dd>${escapeHtml(this.probe.resolvedAddresses.join(", "))}</dd><dt>SSH</dt><dd>${escapeHtml(this.probe.sshBanner)}</dd><dt>${escapeHtml(t("platformClaw.vmAdmin.fingerprint"))}</dt><dd><code>${escapeHtml(this.probe.fingerprint)}</code></dd></dl><p class="muted">${escapeHtml(t("platformClaw.vmAdmin.keyCommentHelp"))}</p><button type="button" class="primary" data-approve-probe>${escapeHtml(t("platformClaw.vmAdmin.approveAndSave"))}</button> <button type="button" data-cancel-probe>${escapeHtml(t("platformClaw.vmAdmin.cancel"))}</button></section>` : ""}${this.pendingMutation ? `<section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.confirmTitle"))}</h3><p>${escapeHtml(t("platformClaw.vmAdmin.confirmBody", { label: this.pendingMutation.label }))}</p><div><button type="button" class="primary" data-confirm-mutation>${escapeHtml(t("platformClaw.vmAdmin.confirm"))}</button> <button type="button" data-cancel-mutation>${escapeHtml(t("platformClaw.vmAdmin.cancel"))}</button></div></section>` : ""}<button data-refresh>${escapeHtml(t("platformClaw.vmAdmin.refresh"))}</button>
            </main></section></openclaw-modal-dialog>`
          : ""
      }`;
    this.bindEvents();
  }
}

const ELEMENT_NAME = "platformclaw-vm-administration";
if (!customElements.get(ELEMENT_NAME)) {
  customElements.define(ELEMENT_NAME, PlatformClawVmAdministrationElement);
}

export function mountPlatformClawVmAdministration(options: {
  fetchImpl: typeof fetch;
  onUnauthenticated: () => void;
}): () => void {
  const existing = document.querySelector<PlatformClawVmAdministrationElement>(ELEMENT_NAME);
  const element =
    existing ?? (document.createElement(ELEMENT_NAME) as PlatformClawVmAdministrationElement);
  element.fetchImpl = options.fetchImpl;
  element.onUnauthenticated = options.onUnauthenticated;
  if (!existing) {
    document.body.append(element);
  }
  return () => {
    if (!existing) {
      element.remove();
    }
  };
}
