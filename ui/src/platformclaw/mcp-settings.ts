import "../components/modal-dialog.ts";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import { PLATFORMCLAW_MCP_API_PATH } from "./web-contract.ts";

type McpServerSetting = {
  serverName: string;
  auth: "bearer" | "api_key" | "oauth";
  headerName?: string;
  scope?: string;
  configured: boolean;
  revision?: number;
  updatedAt?: number;
};

type McpSettings = { servers: McpServerSetting[] };

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    if (character === "&") {
      return "&amp;";
    }
    if (character === "<") {
      return "&lt;";
    }
    if (character === ">") {
      return "&gt;";
    }
    if (character === "'") {
      return "&#39;";
    }
    return "&quot;";
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
  private opened = false;
  private loading = false;
  private busyServer = "";
  private message = "";
  private readonly secretDrafts = new Map<string, string>();
  private unsubscribeLocale = () => {};

  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  onUnauthenticated: () => void = () => {};
  navigate: (url: string) => void = (url) => window.location.assign(url);
  confirmRemove: (message: string) => boolean = (message) => window.confirm(message);

  connectedCallback(): void {
    this.unsubscribeLocale = i18n.subscribe(() => void this.renderLocale());
    void this.initialize().then(() => this.consumeOAuthResult());
  }

  disconnectedCallback(): void {
    this.unsubscribeLocale();
    this.secretDrafts.clear();
  }

  private async initialize(): Promise<void> {
    await loadPlatformClawLocale();
    if (this.isConnected) {
      this.render();
    }
  }

  private async renderLocale(): Promise<void> {
    await loadPlatformClawLocale();
    if (this.isConnected) {
      this.render();
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
        body: JSON.stringify({
          serverName: server.serverName,
          kind: server.auth,
          secret,
        }),
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
    await this.mutate(
      server.serverName,
      async () => {
        const result = await this.request(`${PLATFORMCLAW_MCP_API_PATH}/oauth/start`, {
          method: "POST",
          body: JSON.stringify({ serverName: server.serverName }),
        });
        if (result.status === "redirect" && typeof result.authorizationUrl === "string") {
          const authorizationUrl = safeAuthorizationUrl(result.authorizationUrl);
          if (!authorizationUrl) {
            throw new Error(t("platformClaw.mcp.failed"));
          }
          this.navigate(authorizationUrl);
          return;
        }
        if (result.status === "authorized") {
          this.message = t("platformClaw.mcp.oauthConnected");
          await this.refresh(false);
          return;
        }
        throw new Error(t("platformClaw.mcp.failed"));
      },
      { refresh: false, showSuccess: false },
    );
  }

  private async mutate(
    serverName: string,
    action: () => Promise<void>,
    options: { refresh?: boolean; showSuccess?: boolean } = {},
  ): Promise<void> {
    if (this.busyServer) {
      return;
    }
    this.busyServer = serverName;
    this.message = "";
    this.render();
    try {
      await action();
      if (options.showSuccess !== false) {
        this.message = t("platformClaw.mcp.saved");
      }
      if (options.refresh !== false) {
        await this.refresh(false);
      }
    } catch (error) {
      this.message = error instanceof Error ? error.message : t("platformClaw.mcp.failed");
    } finally {
      this.busyServer = "";
      this.render();
    }
  }

  private bindEvents(): void {
    this.root.querySelector<HTMLElement>("[data-action='open']")?.addEventListener("click", () => {
      this.opened = true;
      this.render();
      void this.refresh();
    });
    const close = () => {
      this.opened = false;
      this.secretDrafts.clear();
      this.render();
    };
    this.root.querySelector<HTMLElement>("[data-action='close']")?.addEventListener("click", close);
    this.root.querySelector("openclaw-modal-dialog")?.addEventListener("modal-cancel", close);
    this.root
      .querySelector<HTMLElement>("[data-action='refresh']")
      ?.addEventListener("click", () => void this.refresh());
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
    for (const input of this.root.querySelectorAll<HTMLInputElement>("[data-secret]")) {
      input.addEventListener("input", () => {
        this.secretDrafts.set(input.dataset.secret ?? "", input.value);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") {
          return;
        }
        event.preventDefault();
        const server = this.settings?.servers.find(
          (entry) => entry.serverName === input.dataset.secret,
        );
        if (server) {
          void this.save(server);
        }
      });
    }
  }

  private consumeOAuthResult(): void {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("mcpOAuth");
    if (result !== "success" && result !== "error") {
      return;
    }
    this.opened = true;
    this.message = t(
      result === "success" ? "platformClaw.mcp.oauthConnected" : "platformClaw.mcp.oauthFailed",
    );
    url.searchParams.delete("mcpOAuth");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    this.render();
    void this.refresh(false);
  }

  private renderServer(server: McpServerSetting): string {
    const busy = this.busyServer === server.serverName;
    const status = server.configured
      ? t("platformClaw.mcp.connected")
      : t("platformClaw.mcp.notConnected");
    const controls =
      server.auth === "oauth"
        ? `<button class="button primary" data-action="oauth" data-server="${escapeHtml(server.serverName)}" aria-label="${escapeHtml(t(server.configured ? "platformClaw.mcp.reconnectLabel" : "platformClaw.mcp.connectLabel", { server: server.serverName }))}" ${busy ? "disabled" : ""}>${escapeHtml(t(server.configured ? "platformClaw.mcp.reconnect" : "platformClaw.mcp.connect"))}</button>`
        : `<label class="secret"><span>${escapeHtml(t(server.auth === "bearer" ? "platformClaw.mcp.tokenLabel" : "platformClaw.mcp.apiKeyLabel", { server: server.serverName }))}</span><input data-secret="${escapeHtml(server.serverName)}" type="password" autocomplete="new-password" maxlength="32768" value="${escapeHtml(this.secretDrafts.get(server.serverName) ?? "")}" placeholder="${escapeHtml(server.auth === "bearer" ? t("platformClaw.mcp.token") : t("platformClaw.mcp.apiKey"))}"></label><button class="button primary" data-action="save" data-server="${escapeHtml(server.serverName)}" aria-label="${escapeHtml(t("platformClaw.mcp.saveLabel", { server: server.serverName }))}" ${busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.mcp.save"))}</button>`;
    const detail =
      server.auth === "oauth"
        ? server.scope
          ? `OAuth · ${t("platformClaw.mcp.scope", { scope: server.scope })}`
          : "OAuth"
        : server.auth === "bearer"
          ? "Bearer token"
          : (server.headerName ?? "API key");
    // Removal is intentionally always available and idempotent. If database
    // deletion committed but Gateway invalidation failed, this is the durable
    // browser retry path even after a reload no longer exposes a revision.
    const remove = `<button class="button" data-action="remove" data-server="${escapeHtml(server.serverName)}" aria-label="${escapeHtml(t("platformClaw.mcp.removeLabel", { server: server.serverName }))}" ${busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.mcp.remove"))}</button>`;
    return `<section class="card" aria-label="${escapeHtml(server.serverName)}"><div class="title"><strong>${escapeHtml(server.serverName)}</strong><span class="status">${escapeHtml(status)}</span></div><p class="muted">${escapeHtml(detail)}</p><div class="controls">${controls}${remove}</div></section>`;
  }

  private render(): void {
    const servers = this.settings?.servers ?? [];
    const connected = servers.filter((server) => server.configured).length;
    this.root.innerHTML = `<style>
      :host { display:block; color:var(--text); font:13px/1.45 var(--font-sans,system-ui,sans-serif); }
      button,input { font:inherit; } .badge { box-sizing:border-box; display:flex; width:100%; min-height:34px; align-items:center; gap:8px; border:0; border-radius:var(--radius-md); padding:7px 9px; background:transparent; color:var(--text); cursor:pointer; text-align:left; }
      .badge:hover,.badge:focus-visible { background:var(--bg-hover); outline:none; } .dot { width:7px; height:7px; border-radius:50%; background:${connected ? "var(--ok)" : "var(--muted)"}; }
      .modal { --openclaw-modal-width:min(560px,calc(100vw - 40px)); } .panel { width:min(560px,100%); max-height:90vh; overflow:auto; border:1px solid var(--border); border-radius:var(--radius-xl); background:var(--bg-elevated); box-shadow:var(--shadow-xl); }
      header { display:flex; justify-content:space-between; align-items:center; padding:20px 22px 12px; } h2 { margin:0; font-size:20px; } .close { border:0; background:transparent; color:inherit; font-size:22px; cursor:pointer; }
      main { padding:8px 22px 22px; display:grid; gap:12px; } .card { padding:14px; border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--card); } .title,.controls { display:flex; gap:8px; align-items:end; flex-wrap:wrap; } .title { align-items:center; justify-content:space-between; } .status,.muted { color:var(--muted); } .muted { margin:4px 0 10px; }
      .secret { display:grid; flex:1; min-width:220px; gap:4px; color:var(--muted); } input { box-sizing:border-box; width:100%; padding:8px 10px; border:1px solid var(--border-strong); border-radius:var(--radius-md); background:var(--bg); color:var(--text); } .button { border:1px solid var(--border-strong); border-radius:var(--radius-md); padding:8px 11px; background:var(--bg-elevated); color:var(--text); cursor:pointer; } .primary { background:var(--accent); color:var(--accent-foreground); border-color:var(--accent); } .button:disabled { opacity:.5; cursor:not-allowed; } .message { padding:10px; background:var(--accent-subtle); border-radius:var(--radius-md); }
    </style><button class="badge" data-action="open"><span class="dot"></span><span>${escapeHtml(t("platformClaw.mcp.open"))}</span></button>${this.opened ? `<openclaw-modal-dialog class="modal" label="${escapeHtml(t("platformClaw.mcp.title"))}"><section class="panel"><header><h2>${escapeHtml(t("platformClaw.mcp.title"))}</h2><button class="close" data-action="close" aria-label="${escapeHtml(t("platformClaw.mcp.close"))}">&times;</button></header><main>${this.loading ? `<p>${escapeHtml(t("common.loading"))}</p>` : ""}${this.message ? `<div class="message" role="status" aria-live="polite">${escapeHtml(this.message)}</div>` : ""}${servers.map((server) => this.renderServer(server)).join("") || `<p class="muted">${escapeHtml(t("platformClaw.mcp.empty"))}</p>`}<button class="button" data-action="refresh">${escapeHtml(t("platformClaw.mcp.refresh"))}</button></main></section></openclaw-modal-dialog>` : ""}`;
    this.bindEvents();
  }
}

const ELEMENT_NAME = "platformclaw-mcp-settings";
if (!customElements.get(ELEMENT_NAME)) {
  customElements.define(ELEMENT_NAME, PlatformClawMcpSettingsElement);
}
