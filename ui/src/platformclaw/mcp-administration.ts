import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import { notifyPlatformClawMcpCatalogChanged } from "./mcp-catalog-events.ts";
import { PLATFORMCLAW_MCP_ADMIN_API_PATH } from "./web-contract.ts";

type AdminMcpServer = {
  name: string;
  enabled: boolean;
  transport: "sse" | "streamable-http" | "stdio" | "invalid";
  target: string;
  editable: boolean;
  credentialMode: "none" | "shared" | "personal";
  personalAuth?: "bearer" | "api_key" | "oauth";
  headerName?: string;
  scope?: string;
  toolPolicy: "all" | "blocked" | "allowlist" | "custom";
  blockedTools: string[];
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return escaped[character] ?? character;
  });
}

function formString(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

class PlatformClawMcpAdministrationElement extends HTMLElement {
  private readonly root = this.attachShadow({ mode: "open" });
  private servers: AdminMcpServer[] = [];
  private loading = true;
  private busy = false;
  private message = "";
  private editing: AdminMcpServer | null | undefined;
  private unsubscribeLocale = () => {};

  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  onUnauthenticated: () => void = () => {};
  confirmRemove: (message: string) => boolean = (message) => window.confirm(message);

  connectedCallback(): void {
    this.unsubscribeLocale = i18n.subscribe(() => void this.initialize(false));
    void this.initialize(true);
  }

  disconnectedCallback(): void {
    this.unsubscribeLocale();
  }

  private async initialize(load: boolean): Promise<void> {
    await loadPlatformClawLocale();
    if (!this.isConnected) {
      return;
    }
    this.render();
    if (load) {
      await this.refresh();
    }
  }

  private async request(init?: RequestInit): Promise<{ servers: AdminMcpServer[] }> {
    const response = await this.fetchImpl(PLATFORMCLAW_MCP_ADMIN_API_PATH, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...init,
    });
    if (response.status === 401) {
      this.onUnauthenticated();
      throw new Error(t("platformClaw.mcp.sessionExpired"));
    }
    const body = (await response.json()) as { servers?: AdminMcpServer[]; error?: string };
    if (!response.ok || !Array.isArray(body.servers)) {
      throw new Error(body.error ?? t("platformClaw.mcp.adminFailed"));
    }
    return { servers: body.servers };
  }

  private async refresh(clearMessage = true): Promise<void> {
    this.loading = true;
    this.render();
    try {
      this.servers = (await this.request()).servers;
      if (clearMessage) {
        this.message = "";
      }
    } catch (error) {
      this.message = error instanceof Error ? error.message : t("platformClaw.mcp.adminFailed");
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async mutate(body: Record<string, unknown>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.message = "";
    this.render();
    try {
      this.servers = (await this.request({ method: "POST", body: JSON.stringify(body) })).servers;
      this.editing = undefined;
      this.message = t("platformClaw.mcp.adminSaved");
      notifyPlatformClawMcpCatalogChanged();
    } catch (error) {
      this.message = error instanceof Error ? error.message : t("platformClaw.mcp.adminFailed");
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private bindEvents(): void {
    this.root.querySelector<HTMLElement>("[data-action='add']")?.addEventListener("click", () => {
      this.editing = null;
      this.render();
    });
    this.root
      .querySelector<HTMLElement>("[data-action='cancel']")
      ?.addEventListener("click", () => {
        this.editing = undefined;
        this.render();
      });
    const administrationForm = this.root.querySelector<HTMLFormElement>("form");
    administrationForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(administrationForm);
      const blockedTools = formString(data, "blockedTools")
        .split(/[\n,]/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
      void this.mutate({
        action: "save-server",
        name: formString(data, "name"),
        url: formString(data, "url"),
        transport: formString(data, "transport"),
        credentialMode: formString(data, "credentialMode"),
        auth: formString(data, "auth"),
        headerName: formString(data, "headerName"),
        secret: formString(data, "secret"),
        scope: formString(data, "scope"),
        blockedTools,
        enabled: data.get("enabled") === "on",
      });
    });
    const updateFields = () => {
      const form = this.root.querySelector<HTMLFormElement>("form");
      if (!form) {
        return;
      }
      const mode = formString(new FormData(form), "credentialMode");
      const url = form.querySelector<HTMLInputElement>("[name='url']")?.value.trim() ?? "";
      const usesPlaintextCredentials = mode !== "none" && /^http:\/\//iu.test(url);
      const warning = form.querySelector<HTMLElement>("[data-http-auth-warning]");
      if (warning) {
        warning.hidden = !usesPlaintextCredentials;
      }
      const oauthOption = form.querySelector<HTMLOptionElement>("[data-personal-only]");
      if (oauthOption) {
        oauthOption.disabled = mode !== "personal";
        if (oauthOption.selected && mode !== "personal") {
          form.querySelector<HTMLSelectElement>("[name='auth']")!.value = "bearer";
        }
      }
      for (const element of form.querySelectorAll<HTMLElement>("[data-credential-field]")) {
        const allowed = (element.dataset.credentialField ?? "").split(" ");
        element.hidden = !allowed.includes(mode);
      }
      const effectiveAuth = form.querySelector<HTMLSelectElement>("[name='auth']")?.value;
      form.querySelector<HTMLElement>("[data-header-field]")!.hidden = effectiveAuth !== "api_key";
      form.querySelector<HTMLElement>("[data-scope-field]")!.hidden =
        mode !== "personal" || effectiveAuth !== "oauth";
      form.querySelector<HTMLElement>("[data-secret-field]")!.hidden = mode !== "shared";
      const headerInput = form.querySelector<HTMLInputElement>("[name='headerName']");
      const secretInput = form.querySelector<HTMLInputElement>("[name='secret']");
      const scopeInput = form.querySelector<HTMLInputElement>("[name='scope']");
      const authSelect = form.querySelector<HTMLSelectElement>("[name='auth']");
      if (authSelect) {
        authSelect.disabled = mode === "none";
        authSelect.required = mode !== "none";
      }
      if (headerInput) {
        headerInput.disabled = effectiveAuth !== "api_key";
        headerInput.required = effectiveAuth === "api_key";
      }
      if (secretInput) {
        secretInput.disabled = mode !== "shared";
        secretInput.required = mode === "shared";
      }
      if (scopeInput) {
        scopeInput.disabled = mode !== "personal" || effectiveAuth !== "oauth";
      }
    };
    for (const select of this.root.querySelectorAll<HTMLSelectElement>("form select")) {
      select.addEventListener("change", updateFields);
    }
    this.root
      .querySelector<HTMLInputElement>("form [name='url']")
      ?.addEventListener("input", updateFields);
    updateFields();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-server]")) {
      const server = this.servers.find((entry) => entry.name === button.dataset.server);
      if (!server) {
        continue;
      }
      button.addEventListener("click", () => {
        if (button.dataset.action === "edit") {
          this.editing = server;
          this.render();
        }
        if (button.dataset.action === "toggle") {
          void this.mutate({
            action: "toggle-server",
            name: server.name,
            enabled: !server.enabled,
          });
        }
        if (
          button.dataset.action === "remove" &&
          this.confirmRemove(t("platformClaw.mcp.adminRemoveConfirm", { server: server.name }))
        ) {
          void this.mutate({ action: "remove-server", name: server.name });
        }
      });
    }
  }

  private renderForm(): string {
    const server = this.editing;
    const editingExisting = Boolean(server);
    const mode = server?.credentialMode ?? "none";
    // Shared header values are redacted by Gateway config reads, so an existing
    // Authorization header cannot be safely inferred as Bearer or API key.
    const auth = server?.personalAuth ?? (mode === "shared" && editingExisting ? "" : "bearer");
    return `<form><div class="form-grid"><label>${escapeHtml(t("platformClaw.mcp.adminName"))}<input name="name" value="${escapeHtml(server?.name ?? "")}" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" maxlength="128" ${editingExisting ? "readonly" : ""} required></label><label>${escapeHtml(t("platformClaw.mcp.adminUrl"))}<input name="url" type="url" value="${escapeHtml(server?.target ?? "")}" maxlength="2048" required></label><div class="warning wide" data-http-auth-warning role="alert" hidden>${escapeHtml(t("platformClaw.mcp.adminHttpCredentialWarning"))}</div><label>${escapeHtml(t("platformClaw.mcp.adminTransport"))}<select name="transport"><option value="streamable-http" ${server?.transport === "streamable-http" ? "selected" : ""}>Streamable HTTP</option><option value="sse" ${server?.transport === "sse" ? "selected" : ""}>SSE</option></select></label><label>${escapeHtml(t("platformClaw.mcp.adminCredentialMode"))}<select name="credentialMode"><option value="none" ${mode === "none" ? "selected" : ""}>${escapeHtml(t("platformClaw.mcp.adminNoCredential"))}</option><option value="shared" ${mode === "shared" ? "selected" : ""}>${escapeHtml(t("platformClaw.mcp.adminSharedCredential"))}</option><option value="personal" ${mode === "personal" ? "selected" : ""}>${escapeHtml(t("platformClaw.mcp.adminPersonalCredential"))}</option></select></label><label data-credential-field="shared personal">${escapeHtml(t("platformClaw.mcp.adminAuth"))}<select name="auth" required>${auth ? "" : `<option value="" selected disabled>${escapeHtml(t("platformClaw.mcp.adminChooseAuth"))}</option>`}<option value="bearer" ${auth === "bearer" ? "selected" : ""}>Bearer token</option><option value="api_key" ${auth === "api_key" ? "selected" : ""}>API key</option><option value="oauth" ${auth === "oauth" ? "selected" : ""} data-personal-only>OAuth</option></select></label><label data-header-field data-credential-field="shared personal">${escapeHtml(t("platformClaw.mcp.adminHeader"))}<input name="headerName" value="${escapeHtml(server?.headerName ?? "X-API-Key")}"></label><label data-secret-field data-credential-field="shared">${escapeHtml(t("platformClaw.mcp.adminSharedSecret"))}<input name="secret" type="password" autocomplete="new-password"></label><label data-scope-field data-credential-field="personal">${escapeHtml(t("platformClaw.mcp.adminScope"))}<input name="scope" value="${escapeHtml(server?.scope ?? "")}"></label><label class="wide">${escapeHtml(t("platformClaw.mcp.adminBlockedTools"))}<textarea name="blockedTools" rows="3">${escapeHtml(server?.blockedTools.join("\n") ?? "")}</textarea><small>${escapeHtml(t("platformClaw.mcp.adminBlockedToolsHelp"))}</small></label><label class="check"><input name="enabled" type="checkbox" ${server?.enabled === false ? "" : "checked"}>${escapeHtml(t("platformClaw.mcp.adminEnabled"))}</label></div><div class="actions"><button class="primary" type="submit" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.mcp.save"))}</button><button type="button" data-action="cancel">${escapeHtml(t("platformClaw.execution.cancel"))}</button></div></form>`;
  }

  private renderServer(server: AdminMcpServer): string {
    const modeKey =
      server.credentialMode === "none"
        ? "platformClaw.mcp.adminNoCredentialShort"
        : server.credentialMode === "shared"
          ? "platformClaw.mcp.adminSharedCredential"
          : "platformClaw.mcp.adminPersonalCredential";
    const toolPolicy =
      server.toolPolicy === "blocked"
        ? t("platformClaw.mcp.adminBlockedCount", { count: String(server.blockedTools.length) })
        : server.toolPolicy === "allowlist" || server.toolPolicy === "custom"
          ? t("platformClaw.mcp.adminCliToolPolicy")
          : t("platformClaw.mcp.adminAllTools");
    return `<article class="card"><div class="card-title"><div><strong>${escapeHtml(server.name)}</strong><p>${escapeHtml(server.target)}</p></div><span class="status ${server.enabled ? "ok" : ""}">${escapeHtml(t(server.enabled ? "common.enabled" : "common.disabled"))}</span></div><div class="meta"><span>${escapeHtml(server.transport)}</span><span>${escapeHtml(t(modeKey))}</span><span>${escapeHtml(toolPolicy)}</span></div><div class="actions">${server.editable ? `<button data-action="edit" data-server="${escapeHtml(server.name)}">${escapeHtml(t("platformClaw.mcp.adminEdit"))}</button>` : `<span class="muted">${escapeHtml(t("platformClaw.mcp.adminCliManaged"))}</span>`}<button data-action="toggle" data-server="${escapeHtml(server.name)}">${escapeHtml(t(server.enabled ? "platformClaw.mcp.adminDisable" : "platformClaw.mcp.adminEnable"))}</button><button data-action="remove" data-server="${escapeHtml(server.name)}">${escapeHtml(t("platformClaw.mcp.remove"))}</button></div></article>`;
  }

  private render(): void {
    this.root.innerHTML = `<style>
      :host{display:block;color:var(--text);font:14px/1.5 var(--font-sans,system-ui,sans-serif)}*{box-sizing:border-box}section{display:grid;gap:14px;padding-bottom:24px;border-bottom:1px solid var(--border);margin-bottom:24px}.heading,.card-title,.actions,.meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.heading,.card-title{justify-content:space-between;align-items:flex-start}h2{margin:0;font-size:18px}p{margin:4px 0;color:var(--muted)}button,input,select,textarea{font:inherit}button{padding:8px 12px;border:1px solid var(--border-strong);border-radius:var(--radius-md);background:var(--bg-elevated);color:var(--text);cursor:pointer}.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-foreground)}button:disabled{opacity:.5}.grid{display:grid;gap:12px}.card,form{padding:16px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--card)}.status,.muted,.meta{color:var(--muted)}.status.ok{color:var(--ok)}.meta span{padding:3px 8px;border-radius:999px;background:var(--bg-elevated)}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.form-grid label{display:grid;gap:5px;color:var(--muted)}.form-grid .wide{grid-column:1/-1}.warning{padding:11px 13px;border:1px solid var(--warning,#d97706);border-radius:var(--radius-md);background:color-mix(in srgb,var(--warning,#d97706) 12%,var(--card));color:var(--text)}.check{display:flex!important;align-items:center}.check input{width:auto}input,select,textarea{width:100%;padding:9px 11px;border:1px solid var(--border-strong);border-radius:var(--radius-md);background:var(--bg);color:var(--text)}form .actions{margin-top:14px}.message,.empty{padding:13px;border-radius:var(--radius-md);background:var(--accent-subtle)}[hidden]{display:none!important}@media(max-width:700px){.form-grid{grid-template-columns:1fr}.form-grid .wide{grid-column:auto}}
    </style><section aria-labelledby="admin-mcp-title"><div class="heading"><div><h2 id="admin-mcp-title">${escapeHtml(t("platformClaw.mcp.adminTitle"))}</h2><p>${escapeHtml(t("platformClaw.mcp.adminIntro"))}</p></div><button data-action="add">${escapeHtml(t("platformClaw.mcp.adminAdd"))}</button></div>${this.message ? `<div class="message" role="status">${escapeHtml(this.message)}</div>` : ""}${this.editing !== undefined ? this.renderForm() : ""}${this.loading ? `<p>${escapeHtml(t("common.loading"))}</p>` : this.servers.length ? `<div class="grid">${this.servers.map((server) => this.renderServer(server)).join("")}</div>` : `<div class="empty">${escapeHtml(t("platformClaw.mcp.adminEmpty"))}</div>`}</section>`;
    this.bindEvents();
  }
}

if (!customElements.get("platformclaw-mcp-administration")) {
  customElements.define("platformclaw-mcp-administration", PlatformClawMcpAdministrationElement);
}
