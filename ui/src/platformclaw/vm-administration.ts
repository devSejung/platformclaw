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
  private loading = false;
  private message = "";
  private messageKind: "error" | "success" = "success";
  private pendingMutation: PendingMutation | null = null;
  private endpointDraft: EndpointDraft | null = null;
  private probe: SafeConnectProbe | null = null;
  private unsubscribeLocale = () => {};
  private generation = 0;
  private readonly formDrafts = new Map<string, Record<string, string>>();
  private readonly expandedForms = new Set<string>();

  declare fetchImpl: typeof fetch;
  declare onUnauthenticated: () => void;

  constructor() {
    super();
    this.fetchImpl ??= globalThis.fetch.bind(globalThis);
    this.onUnauthenticated ??= () => {};
  }

  connectedCallback(): void {
    this.unsubscribeLocale = i18n.subscribe(() => void this.renderLocale());
    void this.renderLocale(true);
  }

  disconnectedCallback(): void {
    this.unsubscribeLocale();
    this.generation++;
    this.loading = false;
    this.pendingMutation = null;
    this.endpointDraft = null;
    this.probe = null;
    this.formDrafts.clear();
    this.expandedForms.clear();
  }

  private isCurrent(generation: number): boolean {
    return this.isConnected && generation === this.generation;
  }

  private async renderLocale(load = false): Promise<void> {
    const generation = this.generation;
    await loadPlatformClawLocale();
    if (this.isCurrent(generation)) {
      this.render();
      if (load) {
        await this.refresh();
      }
    }
  }

  private async request(init?: RequestInit): Promise<VmAdministrationSnapshot> {
    const generation = this.generation;
    const response = await this.fetchImpl(PLATFORMCLAW_VM_ADMIN_API_PATH, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...init,
    });
    if (response.status === 401) {
      if (this.isCurrent(generation)) {
        this.onUnauthenticated();
      }
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
    if (this.loading) {
      return;
    }
    const generation = ++this.generation;
    this.loading = true;
    this.render();
    try {
      const snapshot = await this.request();
      if (!this.isCurrent(generation)) {
        return;
      }
      this.snapshot = snapshot;
      this.message = "";
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.messageKind = "error";
        this.message =
          error instanceof Error ? error.message : t("platformClaw.vmAdmin.requestFailed");
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.loading = false;
        this.render();
      }
    }
  }

  private async mutate(body: Record<string, unknown>, draftKey?: string): Promise<void> {
    if (this.loading) {
      return;
    }
    const generation = ++this.generation;
    this.loading = true;
    this.render();
    try {
      const snapshot = await this.request({ method: "POST", body: JSON.stringify(body) });
      if (!this.isCurrent(generation)) {
        return;
      }
      this.snapshot = snapshot;
      if (draftKey) {
        this.formDrafts.delete(draftKey);
      }
      this.messageKind = "success";
      this.message = t("platformClaw.vmAdmin.saved");
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.messageKind = "error";
        this.message =
          error instanceof Error ? error.message : t("platformClaw.vmAdmin.requestFailed");
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.loading = false;
        this.render();
      }
    }
  }

  private async probeEndpoint(draft: EndpointDraft): Promise<void> {
    if (this.loading) {
      return;
    }
    const generation = ++this.generation;
    this.loading = true;
    this.render();
    try {
      const response = await this.request({
        method: "POST",
        body: JSON.stringify({ action: "probe-endpoint", host: draft.host, port: draft.port }),
      });
      if (!this.isCurrent(generation)) {
        return;
      }
      this.snapshot = response;
      this.endpointDraft = draft;
      this.probe = response.probe ?? null;
      this.messageKind = "success";
      this.message = this.probe ? t("platformClaw.vmAdmin.probeSucceeded") : "";
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.endpointDraft = null;
        this.probe = null;
        this.messageKind = "error";
        this.message =
          error instanceof Error ? error.message : t("platformClaw.vmAdmin.requestFailed");
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.loading = false;
        this.render();
      }
    }
  }

  private async approveProbedEndpoint(): Promise<void> {
    const draft = this.endpointDraft;
    const probe = this.probe;
    if (!draft || !probe || this.loading) {
      return;
    }
    const generation = ++this.generation;
    this.loading = true;
    this.render();
    try {
      // Each awaited stage must still belong to this page before another write starts.
      // Leaving Settings can retire a create request that the server already committed.
      let endpointId = draft.endpointId;
      if (endpointId && !draft.persisted) {
        const snapshot = await this.request({
          method: "POST",
          body: JSON.stringify({ action: "update-endpoint", ...draft }),
        });
        if (!this.isCurrent(generation)) {
          return;
        }
        this.snapshot = snapshot;
      } else if (!endpointId) {
        const findCreatedEndpoint = (snapshot: VmAdministrationSnapshot) =>
          snapshot.endpoints.find(
            (endpoint) => endpoint.host === probe.host && endpoint.port === probe.port,
          )?.id;
        try {
          const snapshot = await this.request({
            method: "POST",
            body: JSON.stringify({ action: "endpoints", ...draft }),
          });
          if (!this.isCurrent(generation)) {
            return;
          }
          this.snapshot = snapshot;
          endpointId = findCreatedEndpoint(this.snapshot);
        } catch (createError) {
          if (!this.isCurrent(generation)) {
            return;
          }
          if (createError instanceof VmAdministrationHttpError) {
            throw createError;
          }
          try {
            const snapshot = await this.request();
            if (!this.isCurrent(generation)) {
              return;
            }
            this.snapshot = snapshot;
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
      const snapshot = await this.request({
        method: "POST",
        body: JSON.stringify({
          action: "host-key",
          endpointId,
          algorithm: probe.algorithm,
          publicKey: probe.publicKey,
          fingerprint: probe.fingerprint,
        }),
      });
      if (!this.isCurrent(generation)) {
        return;
      }
      this.snapshot = snapshot;
      this.formDrafts.delete(`endpoint:${draft.endpointId ?? "new"}`);
      this.endpointDraft = null;
      this.probe = null;
      this.messageKind = "success";
      this.message = t("platformClaw.vmAdmin.saved");
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.messageKind = "error";
        this.message =
          error instanceof Error ? error.message : t("platformClaw.vmAdmin.requestFailed");
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.loading = false;
        this.render();
      }
    }
  }

  private formKey(form: HTMLFormElement): string {
    const id = form.elements.namedItem(
      form.hasAttribute("data-endpoint-probe") ? "endpointId" : "vmHostId",
    );
    const identity = id instanceof HTMLInputElement ? id.value : "new";
    return form.hasAttribute("data-endpoint-probe")
      ? `endpoint:${identity}`
      : `${form.dataset.action}:${identity}`;
  }

  private saveFormDraft(form: HTMLFormElement): void {
    if (this.loading) {
      return;
    }
    const key = this.formKey(form);
    if (form.closest("details")?.open) {
      this.expandedForms.add(key);
    }
    this.formDrafts.set(
      key,
      Object.fromEntries(
        [...new FormData(form)].filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    );
  }

  private bindForm(action: string, mapper: (form: FormData) => Record<string, unknown>): void {
    for (const form of this.root.querySelectorAll<HTMLFormElement>(
      `form[data-action='${action}']`,
    )) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        this.saveFormDraft(event.currentTarget as HTMLFormElement);
        void this.mutate({ action, ...mapper(new FormData(form)) }, this.formKey(form));
      });
    }
  }

  private bindEvents(): void {
    // Drafts belong to forms, not the replacement DOM used for locale/status rendering.
    for (const form of this.root.querySelectorAll<HTMLFormElement>("form")) {
      const key = this.formKey(form);
      const draft = this.formDrafts.get(key);
      for (const control of form.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input, select, textarea")) {
        const value = draft?.[control.name];
        if (value !== undefined) {
          control.value = value;
        }
      }
      form.addEventListener("input", () => this.saveFormDraft(form));
      form.addEventListener("change", () => this.saveFormDraft(form));
      const details = form.closest("details");
      if (details) {
        details.open = this.expandedForms.has(key);
        details.addEventListener("toggle", () => {
          if (!details.isConnected) {
            return;
          }
          if (details.open) {
            this.expandedForms.add(key);
          } else {
            this.expandedForms.delete(key);
          }
        });
      }
    }
    this.root.querySelector("[data-refresh]")?.addEventListener("click", () => void this.refresh());
    for (const form of this.root.querySelectorAll<HTMLFormElement>("form[data-endpoint-probe]")) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        this.saveFormDraft(form);
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
        .administration { min-width: 0; color: var(--text); }
        h2, h3 { margin: 0; } main { display: grid; gap: 16px; padding: 20px; } .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .card { padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); } form { display: grid; gap: 10px; margin-top: 14px; } label { display: grid; gap: 5px; color: var(--muted-strong); }
        input, select, textarea { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg-elevated); color: var(--text); } textarea { min-height: 72px; resize: vertical; }
        input:focus, select:focus, textarea:focus { border-color: var(--accent); outline: none; box-shadow: var(--focus-ring); }
        button { padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg-elevated); color: var(--text); cursor: pointer; } button:hover:not(:disabled), button:focus-visible { background: var(--bg-hover); border-color: var(--border-hover); outline: none; } button.primary { background: var(--accent); color: var(--accent-foreground); border-color: var(--accent); } button.primary:hover:not(:disabled), button.primary:focus-visible { background: var(--accent-hover); border-color: var(--accent-hover); } button.primary:focus-visible { box-shadow: var(--focus-ring); } button:disabled { opacity: .5; cursor: not-allowed; }
        ul { display: grid; gap: 8px; padding: 0; list-style: none; } li { padding: 9px 10px; border-radius: var(--radius-md); background: var(--bg-muted); } .muted { color: var(--muted); } .message { padding: 10px; border-radius: var(--radius-md); background: var(--accent-subtle); } .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; } details { margin-top: 8px; } summary { cursor: pointer; color: var(--muted-strong); } dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; } dt { color: var(--muted); } dd { margin: 0; min-width: 0; overflow-wrap: anywhere; } code { font-family: var(--font-mono, monospace); }
        @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
      </style>
      <section class="administration">
            <main aria-busy="${this.loading}">${this.loading ? `<p role="status">${escapeHtml(t("platformClaw.vmAdmin.loading"))}</p>` : ""}${this.message ? `<div class="message" role="${this.messageKind === "error" ? "alert" : "status"}">${escapeHtml(this.message)}</div>` : ""}
              <div class="grid">
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.endpoints"))}</h3><p class="muted">${escapeHtml(t("platformClaw.vmAdmin.endpointHelp"))}</p>${rows(data?.endpoints.map((endpoint) => `<strong>${escapeHtml(endpoint.label)}</strong> · ${escapeHtml(endpoint.host)}:${endpoint.port} · ${escapeHtml(platformClawStatus(endpoint.status))}${endpoint.hostKeyFingerprint ? `<br><small>${escapeHtml(endpoint.hostKeyFingerprint)}</small>` : ""}<div class="actions">${endpoint.status === "active" ? `<button type="button" data-mutation="disable-endpoint" data-field="endpointId" data-id="${escapeHtml(endpoint.id)}" data-label="${escapeHtml(endpoint.label)}">${escapeHtml(t("platformClaw.vmAdmin.disableEndpoint"))}</button>` : endpoint.hostKeyFingerprint ? `<button type="button" data-mutation="enable-endpoint" data-field="endpointId" data-id="${escapeHtml(endpoint.id)}" data-label="${escapeHtml(endpoint.label)}">${escapeHtml(t("platformClaw.vmAdmin.enableEndpoint"))}</button>` : ""}</div>${endpoint.status !== "active" ? `<details><summary>${escapeHtml(t("platformClaw.vmAdmin.editAndVerify"))}</summary><form data-endpoint-probe><input type="hidden" name="endpointId" value="${escapeHtml(endpoint.id)}"><label>${escapeHtml(t("platformClaw.vmAdmin.label"))}<input name="label" value="${escapeHtml(endpoint.label)}" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.endpointHost"))}<input name="host" value="${escapeHtml(endpoint.host)}" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.port"))}<input name="port" type="number" min="1" max="65535" value="${endpoint.port}" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.adDomain"))}<input name="adDomain" value="${escapeHtml(endpoint.adDomain)}" required></label><button class="primary">${escapeHtml(t("platformClaw.vmAdmin.probeEndpoint"))}</button></form></details>` : ""}`) ?? [])}
                  <form data-endpoint-probe><label>${escapeHtml(t("platformClaw.vmAdmin.label"))}<input name="label" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.endpointHost"))}<input name="host" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.port"))}<input name="port" type="number" min="1" max="65535" value="44422" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.adDomain"))}<input name="adDomain" required></label><button class="primary">${escapeHtml(t("platformClaw.vmAdmin.probeBeforeSave"))}</button></form>
                </section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.hosts"))}</h3>${rows(data?.hosts.map((host) => `<strong>${escapeHtml(host.label)}</strong> · ${escapeHtml(host.targetAddress)} · ${escapeHtml(platformClawStatus(host.status))}<div class="actions"><button type="button" data-mutation="${host.status === "active" ? "disable-host" : "enable-host"}" data-field="vmHostId" data-id="${escapeHtml(host.id)}" data-label="${escapeHtml(host.label)}"${host.status === "disabled" && !activeEndpointIds.has(host.endpointId) ? " disabled" : ""}>${escapeHtml(t(host.status === "active" ? "platformClaw.vmAdmin.disableHost" : "platformClaw.vmAdmin.enableHost"))}</button></div><details><summary>${escapeHtml(t("platformClaw.vmAdmin.executionEnvironment"))}</summary><form data-action="update-host-execution-environment"><input type="hidden" name="vmHostId" value="${escapeHtml(host.id)}">${this.executionEnvironmentFields(host)}<button class="primary">${escapeHtml(t("platformClaw.vmAdmin.saveEnvironment"))}</button></form></details>${host.status === "disabled" ? (activeEndpointIds.has(host.endpointId) ? `<details><summary>${escapeHtml(t("platformClaw.vmAdmin.edit"))}</summary><form data-action="update-host"><input type="hidden" name="vmHostId" value="${escapeHtml(host.id)}"><label>${escapeHtml(t("platformClaw.vmAdmin.endpoint"))}<select name="endpointId">${this.options(activeEndpoints, host.endpointId)}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.vmLabel"))}<input name="label" value="${escapeHtml(host.label)}" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.targetAddress"))}<input name="targetAddress" value="${escapeHtml(host.targetAddress)}" required></label><button class="primary">${escapeHtml(t("platformClaw.vmAdmin.saveChanges"))}</button></form></details>` : `<p class="muted">${escapeHtml(t("platformClaw.vmAdmin.hostEditRequiresActiveEndpoint"))}</p>`) : ""}`) ?? [])}
                  <form data-action="hosts"><label>${escapeHtml(t("platformClaw.vmAdmin.endpoint"))}<select name="endpointId" ${activeEndpoints.length ? "" : "disabled"}>${this.options(activeEndpoints)}</select></label><label>${escapeHtml(t("platformClaw.vmAdmin.vmLabel"))}<input name="label" required></label><label>${escapeHtml(t("platformClaw.vmAdmin.targetAddress"))}<input name="targetAddress" required></label>${this.executionEnvironmentFields()}<button class="primary" ${activeEndpoints.length ? "" : "disabled"}>${escapeHtml(t("platformClaw.vmAdmin.createHost"))}</button></form>
                </section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.allocations"))}</h3><p class="muted">${escapeHtml(t("platformClaw.vmAdmin.allocationHelp"))}</p>${rows(data?.allocations.map((allocation) => `<strong>${escapeHtml(allocation.displayName ?? allocation.accountId)}</strong> · ${escapeHtml(allocation.vmLabel)} · ${escapeHtml(allocation.linuxAccount)} · ${escapeHtml(platformClawStatus(allocation.status))}<div class="actions"><button type="button" data-mutation="revoke-allocation" data-field="allocationId" data-id="${escapeHtml(allocation.id)}" data-label="${escapeHtml(allocation.displayName ?? allocation.accountId)}">${escapeHtml(t("platformClaw.vmAdmin.revokeAllocation"))}</button></div>`) ?? [])}</section>
                <section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.audit"))}</h3>${rows(data?.auditEvents.map((event) => `<strong>${escapeHtml(event.eventType)}</strong> · ${escapeHtml(event.targetType)} · ${escapeHtml(new Date(event.createdAt).toLocaleString())}`) ?? [])}</section>
              </div>${this.probe ? `<section class="card probe"><h3>${escapeHtml(t("platformClaw.vmAdmin.verifyHostKey"))}</h3><p>${escapeHtml(t("platformClaw.vmAdmin.hostKeyTargetHelp"))}</p><dl><dt>DNS</dt><dd>${escapeHtml(this.probe.resolvedAddresses.join(", "))}</dd><dt>SSH</dt><dd>${escapeHtml(this.probe.sshBanner)}</dd><dt>${escapeHtml(t("platformClaw.vmAdmin.fingerprint"))}</dt><dd><code>${escapeHtml(this.probe.fingerprint)}</code></dd></dl><p class="muted">${escapeHtml(t("platformClaw.vmAdmin.keyCommentHelp"))}</p><div class="actions"><button type="button" class="primary" data-approve-probe>${escapeHtml(t("platformClaw.vmAdmin.approveAndSave"))}</button><button type="button" data-cancel-probe>${escapeHtml(t("platformClaw.vmAdmin.cancel"))}</button></div></section>` : ""}${this.pendingMutation ? `<section class="card"><h3>${escapeHtml(t("platformClaw.vmAdmin.confirmTitle"))}</h3><p>${escapeHtml(t("platformClaw.vmAdmin.confirmBody", { label: this.pendingMutation.label }))}</p><div class="actions"><button type="button" class="primary" data-confirm-mutation>${escapeHtml(t("platformClaw.vmAdmin.confirm"))}</button><button type="button" data-cancel-mutation>${escapeHtml(t("platformClaw.vmAdmin.cancel"))}</button></div></section>` : ""}<button data-refresh>${escapeHtml(t("platformClaw.vmAdmin.refresh"))}</button>
            </main></section>`;
    // A pending request must not leave duplicate submit or mutation controls active.
    if (this.loading) {
      for (const control of this.root.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
      >("main input, main select, main textarea, main button")) {
        control.disabled = true;
      }
    }
    this.bindEvents();
  }
}

const ELEMENT_NAME = "platformclaw-vm-administration";
if (!customElements.get(ELEMENT_NAME)) {
  customElements.define(ELEMENT_NAME, PlatformClawVmAdministrationElement);
}
