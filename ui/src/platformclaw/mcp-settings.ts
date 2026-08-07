import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import { PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT } from "./mcp-catalog-events.ts";
import { PLATFORMCLAW_MCP_API_PATH } from "./web-contract.ts";

type McpServerSetting = {
  serverName: string;
  auth: "bearer" | "api_key" | "oauth";
  headerName?: string;
  scope?: string;
  configured: boolean;
};

type McpSettings = { servers: McpServerSetting[] };

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

function safeAuthorizationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

class PlatformClawMcpSettingsElement extends HTMLElement {
  private readonly root = this.attachShadow({ mode: "open" });
  private settings: McpSettings | null = null;
  private loading = true;
  private busyServer = "";
  private message = "";
  private readonly secretDrafts = new Map<string, string>();
  private readonly handleCatalogChanged = () => void this.refresh();
  private unsubscribeLocale = () => {};

  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  onUnauthenticated: () => void = () => {};
  navigate: (url: string) => void = (url) => window.location.assign(url);
  confirmRemove: (message: string) => boolean = (message) => window.confirm(message);

  connectedCallback(): void {
    window.addEventListener(PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT, this.handleCatalogChanged);
    this.unsubscribeLocale = i18n.subscribe(() => void this.initialize(false));
    void this.initialize(true);
  }

  disconnectedCallback(): void {
    window.removeEventListener(PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT, this.handleCatalogChanged);
    this.unsubscribeLocale();
    this.secretDrafts.clear();
  }

  private async initialize(load: boolean): Promise<void> {
    await loadPlatformClawLocale();
    if (!this.isConnected) {
      return;
    }
    this.consumeOAuthResult();
    this.render();
    if (load) {
      await this.refresh(false);
    }
  }

  private async request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(path, {
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
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(typeof body.error === "string" ? body.error : t("platformClaw.mcp.failed"));
    }
    return body;
  }

  private async refresh(clearMessage = true): Promise<void> {
    this.loading = true;
    this.render();
    try {
      this.settings = (await this.request(PLATFORMCLAW_MCP_API_PATH)) as McpSettings;
      if (clearMessage) {
        this.message = "";
      }
    } catch (error) {
      this.message = error instanceof Error ? error.message : t("platformClaw.mcp.failed");
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async mutate(serverName: string, action: () => Promise<void>, success = true) {
    if (this.busyServer) {
      return;
    }
    this.busyServer = serverName;
    this.message = "";
    this.render();
    try {
      await action();
      if (success) {
        this.message = t("platformClaw.mcp.saved");
      }
      await this.refresh(false);
    } catch (error) {
      this.message = error instanceof Error ? error.message : t("platformClaw.mcp.failed");
    } finally {
      this.busyServer = "";
      this.render();
    }
  }

  private async save(server: McpServerSetting): Promise<void> {
    const secret = this.secretDrafts.get(server.serverName) ?? "";
    if (!secret) {
      this.message = t("platformClaw.mcp.secretRequired", { server: server.serverName });
      this.render();
      return;
    }
    await this.mutate(server.serverName, async () => {
      await this.request(`${PLATFORMCLAW_MCP_API_PATH}/credential`, {
        method: "PUT",
        body: JSON.stringify({ serverName: server.serverName, kind: server.auth, secret }),
      });
      this.secretDrafts.delete(server.serverName);
    });
  }

  private async removeCredential(server: McpServerSetting): Promise<void> {
    if (!this.confirmRemove(t("platformClaw.mcp.removeConfirm", { server: server.serverName }))) {
      return;
    }
    await this.mutate(server.serverName, async () => {
      await this.request(`${PLATFORMCLAW_MCP_API_PATH}/credential`, {
        method: "DELETE",
        body: JSON.stringify({ serverName: server.serverName }),
      });
      this.secretDrafts.delete(server.serverName);
    });
  }

  private async connectOAuth(server: McpServerSetting): Promise<void> {
    if (this.busyServer) {
      return;
    }
    this.busyServer = server.serverName;
    this.render();
    try {
      const result = await this.request(`${PLATFORMCLAW_MCP_API_PATH}/oauth/start`, {
        method: "POST",
        body: JSON.stringify({ serverName: server.serverName }),
      });
      if (result.status === "redirect" && typeof result.authorizationUrl === "string") {
        const url = safeAuthorizationUrl(result.authorizationUrl);
        if (!url) {
          throw new Error(t("platformClaw.mcp.failed"));
        }
        this.navigate(url);
        return;
      }
      if (result.status !== "authorized") {
        throw new Error(t("platformClaw.mcp.failed"));
      }
      this.message = t("platformClaw.mcp.oauthConnected");
      await this.refresh(false);
    } catch (error) {
      this.message = error instanceof Error ? error.message : t("platformClaw.mcp.failed");
    } finally {
      this.busyServer = "";
      this.render();
    }
  }

  private consumeOAuthResult(): void {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("mcpOAuth");
    if (result !== "success" && result !== "error") {
      return;
    }
    this.message = t(
      result === "success" ? "platformClaw.mcp.oauthConnected" : "platformClaw.mcp.oauthFailed",
    );
    url.searchParams.delete("mcpOAuth");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }

  private bindEvents(): void {
    this.root
      .querySelector<HTMLElement>("[data-action='refresh']")
      ?.addEventListener("click", () => void this.refresh());
    for (const input of this.root.querySelectorAll<HTMLInputElement>("[data-secret]")) {
      input.addEventListener("input", () =>
        this.secretDrafts.set(input.dataset.secret ?? "", input.value),
      );
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-server]")) {
      const server = this.settings?.servers.find(
        (entry) => entry.serverName === button.dataset.server,
      );
      if (!server) {
        continue;
      }
      button.addEventListener("click", () => {
        if (button.dataset.action === "save") {
          void this.save(server);
        }
        if (button.dataset.action === "remove") {
          void this.removeCredential(server);
        }
        if (button.dataset.action === "oauth") {
          void this.connectOAuth(server);
        }
      });
    }
  }

  private renderServer(server: McpServerSetting): string {
    const busy = this.busyServer === server.serverName;
    const detail =
      server.auth === "oauth"
        ? server.scope
          ? `OAuth · ${t("platformClaw.mcp.scope", { scope: server.scope })}`
          : "OAuth"
        : server.auth === "bearer"
          ? "Bearer token"
          : (server.headerName ?? "API key");
    const connect =
      server.auth === "oauth"
        ? `<button class="primary" data-action="oauth" data-server="${escapeHtml(server.serverName)}" aria-label="${escapeHtml(t(server.configured ? "platformClaw.mcp.reconnectLabel" : "platformClaw.mcp.connectLabel", { server: server.serverName }))}" ${busy ? "disabled" : ""}>${escapeHtml(t(server.configured ? "platformClaw.mcp.reconnect" : "platformClaw.mcp.connect"))}</button>`
        : `<label><span>${escapeHtml(t(server.auth === "bearer" ? "platformClaw.mcp.tokenLabel" : "platformClaw.mcp.apiKeyLabel", { server: server.serverName }))}</span><input data-secret="${escapeHtml(server.serverName)}" type="password" autocomplete="new-password" maxlength="32768" value="${escapeHtml(this.secretDrafts.get(server.serverName) ?? "")}"></label><button class="primary" data-action="save" data-server="${escapeHtml(server.serverName)}" aria-label="${escapeHtml(t("platformClaw.mcp.saveLabel", { server: server.serverName }))}" ${busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.mcp.save"))}</button>`;
    return `<article class="card"><div class="card-title"><strong>${escapeHtml(server.serverName)}</strong><span class="status ${server.configured ? "ok" : ""}">${escapeHtml(t(server.configured ? "platformClaw.mcp.connected" : "platformClaw.mcp.notConnected"))}</span></div><p>${escapeHtml(detail)}</p><div class="controls">${connect}<button data-action="remove" data-server="${escapeHtml(server.serverName)}" aria-label="${escapeHtml(t("platformClaw.mcp.removeLabel", { server: server.serverName }))}" ${busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.mcp.remove"))}</button></div></article>`;
  }

  private render(): void {
    const servers = this.settings?.servers ?? [];
    this.root.innerHTML = `<style>
      :host{display:block;color:var(--text);font:14px/1.5 var(--font-sans,system-ui,sans-serif)}*{box-sizing:border-box}section{display:grid;gap:14px}.heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}h2{margin:0;font-size:18px}p{margin:4px 0;color:var(--muted)}.grid{display:grid;gap:12px}.card{padding:16px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--card)}.card-title,.controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.card-title{justify-content:space-between}.status{color:var(--muted)}.status.ok{color:var(--ok)}label{display:grid;flex:1;min-width:230px;gap:5px;color:var(--muted)}button,input{font:inherit}input{width:100%;padding:9px 11px;border:1px solid var(--border-strong);border-radius:var(--radius-md);background:var(--bg);color:var(--text)}button{padding:8px 12px;border:1px solid var(--border-strong);border-radius:var(--radius-md);background:var(--bg-elevated);color:var(--text);cursor:pointer}.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-foreground)}button:disabled{opacity:.5;cursor:not-allowed}.message,.empty{padding:13px;border-radius:var(--radius-md);background:var(--accent-subtle)}
    </style><section aria-labelledby="personal-mcp-title"><div class="heading"><div><h2 id="personal-mcp-title">${escapeHtml(t("platformClaw.mcp.personalTitle"))}</h2><p>${escapeHtml(t("platformClaw.mcp.personalIntro"))}</p></div><button data-action="refresh">${escapeHtml(t("platformClaw.mcp.refresh"))}</button></div>${this.message ? `<div class="message" role="status" aria-live="polite">${escapeHtml(this.message)}</div>` : ""}${this.loading ? `<p>${escapeHtml(t("common.loading"))}</p>` : servers.length ? `<div class="grid">${servers.map((server) => this.renderServer(server)).join("")}</div>` : `<div class="empty">${escapeHtml(t("platformClaw.mcp.empty"))}<br>${escapeHtml(t("platformClaw.mcp.automatic"))}</div>`}</section>`;
    this.bindEvents();
  }
}

if (!customElements.get("platformclaw-mcp-settings")) {
  customElements.define("platformclaw-mcp-settings", PlatformClawMcpSettingsElement);
}
