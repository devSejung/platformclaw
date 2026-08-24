import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import {
  PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH,
  PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH,
} from "./web-contract.ts";

type Definition = { envName: string; configured?: boolean };
type CredentialMutation = { action: string; envName: string; value?: string };

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      default:
        return "&quot;";
    }
  });
}

class PlatformClawExecCredentialsElement extends HTMLElement {
  private readonly root = this.attachShadow({ mode: "open" });
  private definitions: Definition[] = [];
  private adminDefinitions: Definition[] = [];
  private loading = true;
  private busy = "";
  private message = "";
  private unsubscribeLocale = () => {};
  admin = false;
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  onUnauthenticated: () => void = () => {};

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

  private async request(path: string, init?: RequestInit): Promise<{ definitions: Definition[] }> {
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
      throw new Error(t("platformClaw.execCredentials.sessionExpired"));
    }
    const body = (await response.json()) as { definitions?: Definition[]; error?: string };
    if (!response.ok) {
      throw new Error(body.error ?? t("platformClaw.execCredentials.failed"));
    }
    return { definitions: body.definitions ?? [] };
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const [personal, admin] = await Promise.all([
        this.request(PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH),
        this.admin
          ? this.request(PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH)
          : Promise.resolve({ definitions: [] }),
      ]);
      this.definitions = personal.definitions;
      this.adminDefinitions = admin.definitions;
      this.message = "";
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.execCredentials.failed");
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async mutate(path: string, body: CredentialMutation): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = body.envName;
    this.message = "";
    this.render();
    try {
      await this.request(path, { method: "POST", body: JSON.stringify(body) });
      this.message = t("platformClaw.execCredentials.saved");
      await this.refresh();
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.execCredentials.failed");
    } finally {
      this.busy = "";
      this.render();
    }
  }

  private bindEvents(): void {
    const adminForm = this.root.querySelector<HTMLFormElement>("[data-admin-form]");
    adminForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = adminForm.elements.namedItem("envName") as HTMLInputElement;
      void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH, {
        action: "add",
        envName: input.value,
      });
    });
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-action]")) {
      button.addEventListener("click", () => {
        const envName = button.dataset.env ?? "";
        if (button.dataset.action === "remove-definition") {
          void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH, {
            action: "remove",
            envName,
          });
        }
        if (button.dataset.action === "remove") {
          void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH, { action: "remove", envName });
        }
        if (button.dataset.action === "save") {
          const input = [...this.root.querySelectorAll<HTMLInputElement>("[data-value]")].find(
            (candidate) => candidate.dataset.value === envName,
          );
          if (input?.value) {
            void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH, {
              action: "replace",
              envName,
              value: input.value,
            });
          }
        }
      });
    }
  }

  private render(): void {
    const personal = this.definitions
      .map(
        (item) =>
          `<article class="row"><div><strong>${escapeHtml(item.envName)}</strong><span class="status ${item.configured ? "ok" : ""}">${escapeHtml(t(item.configured ? "platformClaw.execCredentials.configured" : "platformClaw.execCredentials.notConfigured"))}</span></div><div class="actions"><input data-value="${escapeHtml(item.envName)}" type="password" autocomplete="new-password" maxlength="32768" placeholder="${escapeHtml(t("platformClaw.execCredentials.valuePlaceholder"))}"><button class="primary" data-action="save" data-env="${escapeHtml(item.envName)}" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execCredentials.save"))}</button>${item.configured ? `<button data-action="remove" data-env="${escapeHtml(item.envName)}" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execCredentials.remove"))}</button>` : ""}</div></article>`,
      )
      .join("");
    const administration = this.admin
      ? `<section><h3>${escapeHtml(t("platformClaw.execCredentials.adminTitle"))}</h3><p>${escapeHtml(t("platformClaw.execCredentials.adminIntro"))}</p><form data-admin-form><input name="envName" autocomplete="off" maxlength="128" placeholder="OPENAI_API_KEY" required><button class="primary" ${this.busy ? "disabled" : ""}>${escapeHtml(t("platformClaw.execCredentials.add"))}</button></form><div class="chips">${this.adminDefinitions.map((item) => `<span><code>${escapeHtml(item.envName)}</code><button data-action="remove-definition" data-env="${escapeHtml(item.envName)}" aria-label="${escapeHtml(t("platformClaw.execCredentials.remove"))}">×</button></span>`).join("")}</div></section>`
      : "";
    this.root.innerHTML = `<style>:host{display:block;color:var(--text);font:14px/1.5 var(--font-sans,system-ui,sans-serif);margin-bottom:28px}*{box-sizing:border-box}section{display:grid;gap:12px;margin-bottom:24px}h2,h3{margin:0}h2{font-size:18px}h3{font-size:15px}p{margin:0;color:var(--muted)}.panel{padding:18px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--card)}.row{display:grid;gap:10px;padding:14px 0;border-top:1px solid var(--border)}.row>div:first-child{display:flex;justify-content:space-between;gap:12px}.status{color:var(--muted)}.status.ok{color:var(--ok)}.actions,form,.chips{display:flex;gap:8px;flex-wrap:wrap}input,button{font:inherit;border:1px solid var(--border-strong);border-radius:var(--radius-md);padding:8px 10px;background:var(--bg);color:var(--text)}input{flex:1;min-width:220px}.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-foreground)}button{cursor:pointer}button:disabled{opacity:.5}.chips span{display:flex;align-items:center;gap:5px;padding-left:9px;border:1px solid var(--border);border-radius:999px}.chips button{border:0;background:transparent;padding:4px 8px}.message,.empty{padding:11px;border-radius:var(--radius-md);background:var(--accent-subtle)}</style><div class="panel"><section><h2>${escapeHtml(t("platformClaw.execCredentials.title"))}</h2><p>${escapeHtml(t("platformClaw.execCredentials.intro"))}</p>${this.message ? `<div class="message" role="status">${escapeHtml(this.message)}</div>` : ""}${this.loading ? `<p>${escapeHtml(t("common.loading"))}</p>` : personal || `<div class="empty">${escapeHtml(t("platformClaw.execCredentials.empty"))}</div>`}</section>${administration}</div>`;
    this.bindEvents();
  }
}

if (!customElements.get("platformclaw-exec-credentials")) {
  customElements.define("platformclaw-exec-credentials", PlatformClawExecCredentialsElement);
}
