import { html, nothing, render as renderTemplate } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
} from "../components/settings-ui.ts";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import {
  PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH,
  PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH,
} from "./web-contract.ts";
import "./exec-credentials.css";

type Definition = { envName: string; configured?: boolean };
type CredentialMutation = { action: "add" | "remove" | "replace"; envName: string; value?: string };

class PlatformClawExecCredentialsElement extends HTMLElement {
  private definitions: Definition[] = [];
  private adminDefinitions: Definition[] = [];
  private loading = true;
  private busy = "";
  private message = "";
  private readonly secretDrafts = new Map<string, string>();
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
    this.secretDrafts.clear();
    for (const input of this.querySelectorAll<HTMLInputElement>("[data-value]")) {
      input.value = "";
    }
    renderTemplate(nothing, this);
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

  private async refresh(clearMessage = true): Promise<void> {
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
      const allowedNames = new Set(this.definitions.map((definition) => definition.envName));
      for (const envName of this.secretDrafts.keys()) {
        if (!allowedNames.has(envName)) {
          this.secretDrafts.delete(envName);
        }
      }
      if (clearMessage) {
        this.message = "";
      }
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
      if (path === PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH) {
        // The acknowledged row is saved even if the following metadata refresh fails.
        this.secretDrafts.delete(body.envName);
        const definition = this.definitions.find((item) => item.envName === body.envName);
        if (definition) {
          definition.configured = body.action === "replace";
        }
      }
      this.message = t("platformClaw.execCredentials.saved");
      await this.refresh(false);
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : t("platformClaw.execCredentials.failed");
    } finally {
      this.busy = "";
      this.render();
    }
  }

  private renderCredential(item: Definition) {
    const draft = this.secretDrafts.get(item.envName) ?? "";
    const status = draft
      ? "platformClaw.execCredentials.unsaved"
      : item.configured
        ? "platformClaw.execCredentials.configured"
        : "platformClaw.execCredentials.notConfigured";
    return renderSettingsRow({
      stacked: true,
      title: html`<span class="platformclaw-credential-heading"
        ><span>${item.envName}</span>${renderSettingsStatus({
          kind: draft ? "warn" : item.configured ? "ok" : "muted",
          label: t(status),
        })}</span
      >`,
      control: html`
        <form
          class="platformclaw-credential-form"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            this.saveCredential(item.envName);
          }}
        >
          <input
            class="settings-input"
            data-value=${item.envName}
            aria-label=${item.envName}
            type="password"
            autocomplete="new-password"
            maxlength="32768"
            required
            placeholder=${item.configured
              ? "••••••••"
              : t("platformClaw.execCredentials.valuePlaceholder")}
            .value=${live(draft)}
            ?disabled=${this.busy === item.envName}
            @input=${(event: Event) => {
              this.secretDrafts.set(item.envName, (event.currentTarget as HTMLInputElement).value);
              this.render();
            }}
          />
          <button
            class="btn primary"
            data-action="save"
            data-env=${item.envName}
            ?disabled=${Boolean(this.busy) || !draft.trim()}
          >
            ${t("platformClaw.execCredentials.save")}
          </button>
          ${item.configured
            ? html`<button
                type="button"
                class="btn"
                data-action="remove"
                data-env=${item.envName}
                ?disabled=${Boolean(this.busy)}
                @click=${() =>
                  void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH, {
                    action: "remove",
                    envName: item.envName,
                  })}
              >
                ${t("platformClaw.execCredentials.remove")}
              </button>`
            : nothing}
        </form>
      `,
    });
  }

  private saveCredential(envName: string): void {
    const value = this.secretDrafts.get(envName);
    if (value?.trim()) {
      void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH, {
        action: "replace",
        envName,
        value,
      });
    }
  }

  private renderAdministration() {
    return renderSettingsSection(
      {
        title: t("platformClaw.execCredentials.adminTitle"),
        description: t("platformClaw.execCredentials.adminIntro"),
      },
      html`
        ${renderSettingsRow({
          title: t("platformClaw.execCredentials.add"),
          stacked: true,
          control: html`
            <form
              class="platformclaw-credential-definition-form"
              data-admin-form
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                const form = event.currentTarget as HTMLFormElement;
                const envName = (form.elements.namedItem("envName") as HTMLInputElement).value;
                void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH, {
                  action: "add",
                  envName,
                });
              }}
            >
              <input
                class="settings-input"
                name="envName"
                aria-label=${t("platformClaw.execCredentials.adminTitle")}
                autocomplete="off"
                maxlength="128"
                placeholder="OPENAI_API_KEY"
                required
                ?disabled=${Boolean(this.busy)}
              />
              <button class="btn primary" ?disabled=${Boolean(this.busy)}>
                ${t("platformClaw.execCredentials.add")}
              </button>
            </form>
          `,
        })}
        ${repeat(
          this.adminDefinitions,
          (item) => item.envName,
          (item) =>
            renderSettingsRow({
              title: item.envName,
              control: html`
                <button
                  class="btn"
                  data-action="remove-definition"
                  data-env=${item.envName}
                  ?disabled=${Boolean(this.busy)}
                  @click=${() =>
                    void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH, {
                      action: "remove",
                      envName: item.envName,
                    })}
                >
                  ${t("platformClaw.execCredentials.remove")}
                </button>
              `,
            }),
        )}
      `,
    );
  }

  private render(): void {
    if (!this.isConnected) {
      return;
    }
    // Keyed Lit rows retain the actual input nodes and caret while sibling saves complete.
    renderTemplate(
      html`
        ${renderSettingsSection(
          {
            title: t("platformClaw.execCredentials.title"),
            description: html`${t("platformClaw.execCredentials.intro")}
            ${t("platformClaw.execCredentials.replaceHelp")}`,
          },
          this.definitions.length
            ? repeat(
                this.definitions,
                (item) => item.envName,
                (item) => this.renderCredential(item),
              )
            : renderSettingsEmpty(
                t(this.loading ? "common.loading" : "platformClaw.execCredentials.empty"),
              ),
        )}
        ${this.admin ? this.renderAdministration() : nothing}
        ${this.message
          ? html`<p class="settings-page__intro" role="status" aria-live="polite">
              ${this.message}
            </p>`
          : nothing}
      `,
      this,
    );
  }
}

if (!customElements.get("platformclaw-exec-credentials")) {
  customElements.define("platformclaw-exec-credentials", PlatformClawExecCredentialsElement);
}
