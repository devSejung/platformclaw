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

class PlatformClawVmAdministrationElement extends HTMLElement {
  private readonly root = this.attachShadow({ mode: "open" });
  private snapshot: VmAdministrationSnapshot | null = null;
  private opened = false;
  private loading = false;
  private message = "";
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
      throw new Error(t("platformClaw.execution.sessionExpired"));
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
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
    this.root.querySelector<HTMLDialogElement>("dialog.backdrop")?.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        closeDialog();
      },
    );
    this.root.querySelector("[data-refresh]")?.addEventListener("click", () => void this.refresh());
    this.bindForm("endpoints", (form) => ({
      label: field(form, "label"),
      host: field(form, "host"),
      port: Number(field(form, "port")),
      adDomain: field(form, "adDomain"),
    }));
    this.bindForm("host-key", (form) => ({
      endpointId: field(form, "endpointId"),
      algorithm: field(form, "algorithm"),
      publicKey: field(form, "publicKey"),
      fingerprint: field(form, "fingerprint"),
    }));
    this.bindForm("hosts", (form) => ({
      endpointId: field(form, "endpointId"),
      label: field(form, "label"),
      targetAddress: field(form, "targetAddress"),
    }));
    this.bindForm("allocations", (form) => ({
      agentId: field(form, "agentId"),
      vmHostId: field(form, "vmHostId"),
      linuxAccount: field(form, "linuxAccount"),
    }));
  }

  private options(values: ReadonlyArray<{ id: string; label: string }>): string {
    return values
      .map((value) => `<option value="${escapeHtml(value.id)}">${escapeHtml(value.label)}</option>`)
      .join("");
  }

  private render(): void {
    const data = this.snapshot;
    const pending = data?.endpoints.filter((endpoint) => endpoint.status === "pending") ?? [];
    const activeEndpoints =
      data?.endpoints.filter((endpoint) => endpoint.status === "active") ?? [];
    const activeHosts = data?.hosts.filter((host) => host.status === "active") ?? [];
    const agents = data?.agents.filter((agent) => !agent.allocationId) ?? [];
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
        .backdrop { inset: 0; box-sizing: border-box; width: 100vw; max-width: none; height: 100vh; max-height: none; margin: 0; border: 0; padding: 24px; background: color-mix(in srgb, var(--bg) 18%, #000 82%); place-items: center; }
        .backdrop[open] { display: grid; }
        .dialog { width: min(1040px, 100%); max-height: min(860px, calc(100vh - 48px)); overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--bg); color: var(--text); box-shadow: var(--shadow-xl); }
        header { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; gap: 16px; padding: 18px 22px; border-bottom: 1px solid var(--border); background: var(--bg-elevated); }
        h2, h3 { margin: 0; } main { display: grid; gap: 16px; padding: 20px; } .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .card { padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); } form { display: grid; gap: 10px; margin-top: 14px; } label { display: grid; gap: 5px; color: var(--muted-strong); }
        input, select, textarea { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg-elevated); color: var(--text); } textarea { min-height: 72px; resize: vertical; }
        input:focus, select:focus, textarea:focus { border-color: var(--accent); outline: none; box-shadow: var(--focus-ring); }
        button { padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg-elevated); color: var(--text); cursor: pointer; } button:hover:not(:disabled), button:focus-visible { background: var(--bg-hover); border-color: var(--border-hover); outline: none; } button.primary { background: var(--accent); color: var(--accent-foreground); border-color: var(--accent); } button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); } button:disabled { opacity: .5; cursor: not-allowed; }
        ul { display: grid; gap: 8px; padding: 0; list-style: none; } li { padding: 9px 10px; border-radius: var(--radius-md); background: var(--bg-muted); } .muted { color: var(--muted); } .message { padding: 10px; border-radius: var(--radius-md); background: var(--accent-subtle); }
        @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } .backdrop { padding: 8px; } }
      </style>
      <button class="open" data-open>${escapeHtml(t("platformClaw.vmAdmin.open"))}</button>
      ${
        this.opened
          ? `<dialog class="backdrop" aria-label="${escapeHtml(t("platformClaw.vmAdmin.title"))}"><section class="dialog">
            <header><div><h2>${escapeHtml(t("platformClaw.vmAdmin.title"))}</h2><div class="muted">${escapeHtml(t("platformClaw.vmAdmin.intro"))}</div></div><button data-close aria-label="${escapeHtml(t("platformClaw.vmAdmin.close"))}">×</button></header>
            <main>${this.loading ? `<p>${escapeHtml(t("platformClaw.vmAdmin.loading"))}</p>` : ""}${this.message ? `<div class="message">${escapeHtml(this.message)}</div>` : ""}
              <div class="grid">
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.endpoints"))}</h3><p class="muted">${escapeHtml(t("platformClaw.vmAdmin.endpointHelp"))}</p>${rows(data?.endpoints.map((endpoint) => `<strong>${escapeHtml(endpoint.label)}</strong> · ${escapeHtml(endpoint.host)}:${endpoint.port} · ${escapeHtml(platformClawStatus(endpoint.status))}${endpoint.hostKeyFingerprint ? `<br><small>${escapeHtml(endpoint.hostKeyFingerprint)}</small>` : ""}`) ?? [])}
                  <form data-action="endpoints"><label>${escapeHtml(t("platformClaw.vmAdmin.label"))}<input name="label" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.endpointHost"))}<input name="host" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.port"))}<input name="port" type="number" min="1" max="65535" value="44422" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.adDomain"))}<input name="adDomain" required></label><button class="primary">${escapeHtml(t("platformClaw.vmAdmin.createEndpoint"))}</button></form>
                  ${pending.length ? `<form data-action="host-key"><label>${escapeHtml(t("platformClaw.vmAdmin.endpoint"))}<select name="endpointId">${this.options(pending)}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.algorithm"))}<input name="algorithm" value="ssh-ed25519" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.publicKey"))}<textarea name="publicKey" required></textarea></label><label>${escapeHtml(t("platformClaw.vmAdmin.fingerprint"))}<input name="fingerprint" placeholder="SHA256:…" required></label><button class="primary">${escapeHtml(t("platformClaw.vmAdmin.approveKey"))}</button></form>` : ""}
                </section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.hosts"))}</h3>${rows(data?.hosts.map((host) => `<strong>${escapeHtml(host.label)}</strong> · ${escapeHtml(host.targetAddress)} · ${escapeHtml(platformClawStatus(host.status))}`) ?? [])}
                  <form data-action="hosts"><label>${escapeHtml(t("platformClaw.vmAdmin.endpoint"))}<select name="endpointId" ${activeEndpoints.length ? "" : "disabled"}>${this.options(activeEndpoints)}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.vmLabel"))}<input name="label" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.targetAddress"))}<input name="targetAddress" required></label><button class="primary" ${activeEndpoints.length ? "" : "disabled"}>${escapeHtml(t("platformClaw.vmAdmin.createHost"))}</button></form>
                </section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.allocations"))}</h3>${rows(data?.allocations.map((allocation) => `<strong>${escapeHtml(allocation.displayName ?? allocation.accountId)}</strong> · ${escapeHtml(allocation.vmLabel)} · ${escapeHtml(allocation.linuxAccount)} · ${escapeHtml(platformClawStatus(allocation.status))}`) ?? [])}
                  <form data-action="allocations"><label>${escapeHtml(t("platformClaw.vmAdmin.employee"))}<select name="agentId" ${agents.length ? "" : "disabled"}>${agents.map((agent) => `<option value="${escapeHtml(agent.agentId)}">${escapeHtml(agent.displayName ?? agent.accountId)} (${escapeHtml(agent.accountId)})</option>`).join("")}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.vm"))}<select name="vmHostId" ${activeHosts.length ? "" : "disabled"}>${this.options(activeHosts)}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.linuxAccount"))}<input name="linuxAccount" required></label><button class="primary" ${agents.length && activeHosts.length ? "" : "disabled"}>${escapeHtml(t("platformClaw.vmAdmin.assign"))}</button></form>
                </section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.audit"))}</h3>${rows(data?.auditEvents.map((event) => `<strong>${escapeHtml(event.eventType)}</strong> · ${escapeHtml(event.targetType)} · ${escapeHtml(new Date(event.createdAt).toLocaleString())}`) ?? [])}</section>
              </div><button data-refresh>${escapeHtml(t("platformClaw.vmAdmin.refresh"))}</button>
            </main></section></dialog>`
          : ""
      }`;
    this.bindEvents();
    const modal = this.root.querySelector<HTMLDialogElement>("dialog.backdrop");
    if (modal && !modal.open) {
      if (typeof modal.showModal === "function") {
        modal.showModal();
      } else {
        modal.setAttribute("open", "");
      }
    }
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
