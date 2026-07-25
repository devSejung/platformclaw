import { i18n, t } from "../i18n/index.ts";
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

  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  onUnauthenticated: () => void = () => {};

  connectedCallback(): void {
    this.unsubscribeLocale = i18n.subscribe(() => this.render());
    this.render();
  }

  disconnectedCallback(): void {
    this.unsubscribeLocale();
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
    this.root.querySelector("[data-open]")?.addEventListener("click", () => {
      this.opened = true;
      void this.refresh();
    });
    this.root.querySelector("[data-close]")?.addEventListener("click", () => {
      this.opened = false;
      this.render();
    });
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
        :host { color-scheme: light dark; font: 13px/1.45 system-ui, sans-serif; }
        button, input, select, textarea { font: inherit; }
        .open { position: fixed; z-index: 1100; top: 12px; right: 190px; padding: 7px 12px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 999px; background: Canvas; color: CanvasText; cursor: pointer; box-shadow: 0 5px 18px #0002; }
        .backdrop { position: fixed; z-index: 1300; inset: 0; display: grid; place-items: center; padding: 24px; background: #0007; }
        .dialog { width: min(1040px, 100%); max-height: min(860px, calc(100vh - 48px)); overflow: auto; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 18px; background: Canvas; color: CanvasText; box-shadow: 0 24px 70px #0006; }
        header { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; gap: 16px; padding: 18px 22px; border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent); background: Canvas; }
        h2, h3 { margin: 0; } main { display: grid; gap: 16px; padding: 20px; } .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .card { padding: 16px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 14px; } form { display: grid; gap: 10px; margin-top: 14px; } label { display: grid; gap: 5px; }
        input, select, textarea { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; background: Canvas; color: CanvasText; } textarea { min-height: 72px; resize: vertical; }
        button { padding: 8px 12px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; background: Canvas; color: CanvasText; cursor: pointer; } button.primary { background: #c85c35; color: white; border-color: #c85c35; } button:disabled { opacity: .5; cursor: not-allowed; }
        ul { display: grid; gap: 8px; padding: 0; list-style: none; } li { padding: 9px 10px; border-radius: 9px; background: color-mix(in srgb, CanvasText 5%, Canvas); } .muted { color: color-mix(in srgb, CanvasText 65%, transparent); } .message { padding: 10px; border-radius: 9px; background: color-mix(in srgb, #c85c35 12%, Canvas); }
        @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } .open { top: 54px; right: 18px; } .backdrop { padding: 8px; } }
      </style>
      <button class="open" data-open>${escapeHtml(t("platformClaw.vmAdmin.open"))}</button>
      ${
        this.opened
          ? `<div class="backdrop"><section class="dialog" role="dialog" aria-label="${escapeHtml(t("platformClaw.vmAdmin.title"))}">
            <header><div><h2>${escapeHtml(t("platformClaw.vmAdmin.title"))}</h2><div class="muted">${escapeHtml(t("platformClaw.vmAdmin.intro"))}</div></div><button data-close aria-label="${escapeHtml(t("platformClaw.vmAdmin.close"))}">×</button></header>
            <main>${this.loading ? `<p>${escapeHtml(t("platformClaw.vmAdmin.loading"))}</p>` : ""}${this.message ? `<div class="message">${escapeHtml(this.message)}</div>` : ""}
              <div class="grid">
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.endpoints"))}</h3><p class="muted">${escapeHtml(t("platformClaw.vmAdmin.endpointHelp"))}</p>${rows(data?.endpoints.map((endpoint) => `<strong>${escapeHtml(endpoint.label)}</strong> · ${escapeHtml(endpoint.host)}:${endpoint.port} · ${escapeHtml(endpoint.status)}${endpoint.hostKeyFingerprint ? `<br><small>${escapeHtml(endpoint.hostKeyFingerprint)}</small>` : ""}`) ?? [])}
                  <form data-action="endpoints"><label>${escapeHtml(t("platformClaw.vmAdmin.label"))}<input name="label" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.endpointHost"))}<input name="host" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.port"))}<input name="port" type="number" min="1" max="65535" value="44422" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.adDomain"))}<input name="adDomain" required></label><button class="primary">${escapeHtml(t("platformClaw.vmAdmin.createEndpoint"))}</button></form>
                  ${pending.length ? `<form data-action="host-key"><label>${escapeHtml(t("platformClaw.vmAdmin.endpoint"))}<select name="endpointId">${this.options(pending)}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.algorithm"))}<input name="algorithm" value="ssh-ed25519" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.publicKey"))}<textarea name="publicKey" required></textarea></label><label>${escapeHtml(t("platformClaw.vmAdmin.fingerprint"))}<input name="fingerprint" placeholder="SHA256:…" required></label><button class="primary">${escapeHtml(t("platformClaw.vmAdmin.approveKey"))}</button></form>` : ""}
                </section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.hosts"))}</h3>${rows(data?.hosts.map((host) => `<strong>${escapeHtml(host.label)}</strong> · ${escapeHtml(host.targetAddress)} · ${escapeHtml(host.status)}`) ?? [])}
                  <form data-action="hosts"><label>${escapeHtml(t("platformClaw.vmAdmin.endpoint"))}<select name="endpointId" ${activeEndpoints.length ? "" : "disabled"}>${this.options(activeEndpoints)}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.vmLabel"))}<input name="label" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.targetAddress"))}<input name="targetAddress" required></label><button class="primary" ${activeEndpoints.length ? "" : "disabled"}>${escapeHtml(t("platformClaw.vmAdmin.createHost"))}</button></form>
                </section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.allocations"))}</h3>${rows(data?.allocations.map((allocation) => `<strong>${escapeHtml(allocation.displayName ?? allocation.accountId)}</strong> · ${escapeHtml(allocation.vmLabel)} · ${escapeHtml(allocation.linuxAccount)} · ${escapeHtml(allocation.status)}`) ?? [])}
                  <form data-action="allocations"><label>${escapeHtml(t("platformClaw.vmAdmin.employee"))}<select name="agentId" ${agents.length ? "" : "disabled"}>${agents.map((agent) => `<option value="${escapeHtml(agent.agentId)}">${escapeHtml(agent.displayName ?? agent.accountId)} (${escapeHtml(agent.accountId)})</option>`).join("")}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.vm"))}<select name="vmHostId" ${activeHosts.length ? "" : "disabled"}>${this.options(activeHosts)}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.linuxAccount"))}<input name="linuxAccount" required></label><button class="primary" ${agents.length && activeHosts.length ? "" : "disabled"}>${escapeHtml(t("platformClaw.vmAdmin.assign"))}</button></form>
                </section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.audit"))}</h3>${rows(data?.auditEvents.map((event) => `<strong>${escapeHtml(event.eventType)}</strong> · ${escapeHtml(event.targetType)} · ${escapeHtml(new Date(event.createdAt).toLocaleString())}`) ?? [])}</section>
              </div><button data-refresh>${escapeHtml(t("platformClaw.vmAdmin.refresh"))}</button>
            </main></section></div>`
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
  document.querySelector(ELEMENT_NAME)?.remove();
  const element = document.createElement(ELEMENT_NAME) as PlatformClawVmAdministrationElement;
  element.fetchImpl = options.fetchImpl;
  element.onUnauthenticated = options.onUnauthenticated;
  document.body.append(element);
  return () => element.remove();
}
