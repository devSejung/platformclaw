import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { i18n } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import { PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT } from "./mcp-catalog-events.ts";
import {
  createMcpSettingsDraft,
  type HeaderDraft,
  type McpServerSetting,
  type SettingsDraft,
} from "./mcp-settings-model.ts";
import { mcpWorkspaceStyles } from "./mcp-workspace-styles.ts";
import {
  createMcpCatalogSelection,
  renderMcpWorkspace,
  selectMcpCatalogPage,
  type McpCatalogRow,
  type McpCatalogSelection,
} from "./mcp-workspace.ts";
import { PLATFORMCLAW_MCP_API_PATH } from "./web-contract.ts";

class McpSettingsRequestError extends Error {
  constructor(
    message: string,
    readonly savedServers?: McpServerSetting[],
  ) {
    super(message);
  }
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

class PlatformClawMcpSettingsElement extends OpenClawLitElement {
  static override styles = mcpWorkspaceStyles;
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => {};
  @property({ attribute: false }) navigate: (url: string) => void = (url) =>
    window.location.assign(url);
  @property({ attribute: false }) confirmRemove: (message: string) => boolean = (message) =>
    window.confirm(message);
  @state() private servers: McpServerSetting[] = [];
  @state() private selection = createMcpCatalogSelection();
  @state() private loading = true;
  @state() private busyServer = "";
  @state() private feedback: {
    kind: "error" | "info" | "load-error";
    message: string;
    serverName?: string;
  } | null = null;
  private readonly drafts = new Map<string, SettingsDraft>();
  private nextHeaderId = 0;
  private generation = 0;
  private refreshing = false;
  private unsubscribeLocale = () => {};
  private readonly handleCatalogChanged = () => void this.refresh();
  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT, this.handleCatalogChanged);
    this.unsubscribeLocale = i18n.subscribe(
      () => void loadPlatformClawLocale().then(() => this.requestUpdate()),
    );
    void loadPlatformClawLocale().then(() => {
      if (this.isConnected) {
        this.consumeOAuthResult();
        void this.refresh();
      }
    });
  }
  override disconnectedCallback(): void {
    this.generation++;
    this.unsubscribeLocale();
    this.drafts.clear();
    this.servers = [];
    this.busyServer = "";
    this.loading = true;
    this.refreshing = false;
    window.removeEventListener(PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT, this.handleCatalogChanged);
    super.disconnectedCallback();
  }
  private async request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const generation = this.generation;
    const response = await this.fetchImpl(path, {
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...init,
    });
    if (!this.isConnected || generation !== this.generation) {
      throw new Error(t("platformClaw.mcp.failed"));
    }
    if (response.status === 401) {
      this.onUnauthenticated();
      throw new Error(t("platformClaw.mcp.sessionExpired"));
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (!this.isConnected || generation !== this.generation) {
      throw new Error(t("platformClaw.mcp.failed"));
    }
    if (!response.ok) {
      throw new McpSettingsRequestError(
        typeof body.error === "string" ? body.error : t("platformClaw.mcp.failed"),
        body.saved === true && Array.isArray(body.servers)
          ? (body.servers as McpServerSetting[])
          : undefined,
      );
    }
    return body;
  }
  private catalog(body: Record<string, unknown>): void {
    if (!Array.isArray(body.servers)) {
      throw new Error(t("platformClaw.mcp.failed"));
    }
    this.servers = body.servers as McpServerSetting[];
    // Passive catalog updates refresh clean snapshots only. Edited values retain
    // their original CAS and policy identity until explicit cancel or reload.
    for (const [name, draft] of this.drafts) {
      if (!draft.dirty || !this.servers.some((server) => server.serverName === name)) {
        this.drafts.delete(name);
      }
    }
    this.reconcileSelection();
  }
  private rows(): McpCatalogRow[] {
    return this.servers.map((server) => ({
      id: server.serverName,
      name: server.serverName,
      origin: server.origin,
      credentialMode: server.credentialMode,
      enabled: server.globalEnabled && server.userEnabled,
      globalEnabled: server.globalEnabled,
      configured: server.configured,
    }));
  }
  private reconcileSelection(): void {
    const page = selectMcpCatalogPage(this.rows(), this.selection);
    this.selection = {
      ...this.selection,
      page: page.page,
      selected: page.visible.some((row) => row.id === this.selection.selected)
        ? this.selection.selected
        : (page.visible[0]?.id ?? null),
    };
  }
  private filter(patch: Partial<McpCatalogSelection>): void {
    this.selection = { ...this.selection, ...patch };
    this.reconcileSelection();
  }
  private async refresh(discardDrafts = false): Promise<void> {
    if (this.busyServer || this.refreshing) {
      return;
    }
    const generation = ++this.generation;
    this.loading = true;
    this.refreshing = true;
    try {
      const body = await this.request(PLATFORMCLAW_MCP_API_PATH);
      if (this.isConnected && generation === this.generation) {
        if (discardDrafts) {
          this.drafts.clear();
        }
        this.catalog(body);
        if (discardDrafts || this.feedback?.kind === "load-error") {
          this.feedback = null;
        }
      }
    } catch (error) {
      if (this.isConnected && generation === this.generation) {
        this.feedback = {
          kind: "load-error",
          message: error instanceof Error ? error.message : t("platformClaw.mcp.failed"),
        };
      }
    } finally {
      if (this.isConnected && generation === this.generation) {
        this.loading = false;
        this.refreshing = false;
      }
    }
  }
  private draft(server: McpServerSetting): SettingsDraft {
    let draft = this.drafts.get(server.serverName);
    if (!draft) {
      draft = createMcpSettingsDraft(server, () => ++this.nextHeaderId);
      this.drafts.set(server.serverName, draft);
    }
    return draft;
  }
  private edit(server: McpServerSetting, change: (draft: SettingsDraft) => void): void {
    if (this.loading || this.busyServer) {
      return;
    }
    const draft = this.draft(server);
    change(draft);
    draft.dirty = true;
    draft.error = "";
    draft.message = "";
    this.requestUpdate();
  }
  private async mutate(server: McpServerSetting, action: () => Promise<void>): Promise<void> {
    if (this.busyServer || this.loading) {
      return;
    }
    const generation = this.generation;
    this.busyServer = server.serverName;
    this.feedback = null;
    const draft = this.draft(server);
    draft.error = "";
    draft.message = "";
    try {
      await action();
    } catch (error) {
      if (this.isConnected && generation === this.generation) {
        if (error instanceof McpSettingsRequestError && error.savedServers) {
          // The database committed. Adopt its revision and remove plaintext so
          // retrying connection disposal cannot loop on an obsolete base revision.
          this.catalog({ servers: error.savedServers });
          this.drafts.delete(server.serverName);
        }
        this.feedback = {
          kind: "error",
          serverName: server.serverName,
          message: error instanceof Error ? error.message : t("platformClaw.mcp.failed"),
        };
      }
    } finally {
      if (this.isConnected && generation === this.generation) {
        this.busyServer = "";
      }
    }
  }
  private async save(server: McpServerSetting): Promise<void> {
    if (this.loading || this.busyServer) {
      return;
    }
    const draft = this.draft(server);
    const names = draft.headers
      .filter((header) => header.name.trim())
      .map((header) => header.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) {
      draft.error = t("platformClaw.mcp.duplicateHeader");
      this.requestUpdate();
      return;
    }
    const headers: Array<{ name: string; value?: string }> = [];
    for (const header of draft.headers) {
      const name = header.name.trim();
      if (!name && header.value.kind === "editing" && !header.value.value.trim()) {
        continue;
      }
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) {
        draft.error = t("platformClaw.mcp.invalidHeader");
        this.requestUpdate();
        return;
      }
      if (header.value.kind === "stored") {
        headers.push({ name });
      } else if (header.value.kind === "deleted") {
        headers.push({ name, value: "" });
      } else if (header.value.value.trim()) {
        headers.push({ name, value: header.value.value });
      } else if (header.savedName) {
        headers.push({ name });
      }
    }
    const credential =
      draft.credential.kind === "editing" &&
      draft.credential.value.trim() &&
      (server.auth === "bearer" || server.auth === "api_key")
        ? { kind: server.auth, secret: draft.credential.value }
        : undefined;
    await this.mutate(server, async () => {
      const body = await this.request(PLATFORMCLAW_MCP_API_PATH, {
        method: "PUT",
        body: JSON.stringify({
          serverName: server.serverName,
          expectedRevision: draft.revision,
          expectedPolicyFingerprint: draft.policyFingerprint,
          enabled: server.userEnabled,
          headers,
          ...(credential
            ? { credential, expectedCredentialFingerprint: draft.credentialFingerprint }
            : {}),
        }),
      });
      this.catalog(body);
      this.drafts.delete(server.serverName);
      const updated = this.servers.find((entry) => entry.serverName === server.serverName);
      if (updated) {
        this.draft(updated).message = t("platformClaw.mcp.mySettingsSaved");
      }
    });
  }
  private async toggle(name: string, enabled: boolean): Promise<void> {
    const server = this.servers.find((entry) => entry.serverName === name);
    if (!server || !server.globalEnabled || this.busyServer || this.loading) {
      return;
    }
    if (enabled && server.credentialMode === "personal" && !server.configured) {
      this.selection = { ...this.selection, selected: name, picking: false };
      this.draft(server).error = t("platformClaw.mcp.authenticateBeforeEnable");
      this.requestUpdate();
      return;
    }
    await this.mutate(server, async () => {
      const body = await this.request(PLATFORMCLAW_MCP_API_PATH, {
        method: "PUT",
        body: JSON.stringify({
          serverName: name,
          expectedRevision: server.settingsRevision,
          enabled,
        }),
      });
      this.catalog(body);
      const updated = this.servers.find((entry) => entry.serverName === name);
      // A toggle may advance only a draft based on the same snapshot. Rebasing
      // an already-stale draft would authorize overwriting another client's values.
      const draft = this.drafts.get(name);
      if (updated && draft && draft.revision === server.settingsRevision) {
        draft.revision = updated.settingsRevision;
        draft.message = t("platformClaw.mcp.permissionSaved");
      }
    });
  }
  private async removeCredential(server: McpServerSetting): Promise<void> {
    if (!this.confirmRemove(t("platformClaw.mcp.removeConfirm", { server: server.serverName }))) {
      return;
    }
    await this.mutate(server, async () => {
      await this.request(`${PLATFORMCLAW_MCP_API_PATH}/credential`, {
        method: "DELETE",
        body: JSON.stringify({ serverName: server.serverName }),
      });
      this.catalog(await this.request(PLATFORMCLAW_MCP_API_PATH));
      const updated = this.servers.find((entry) => entry.serverName === server.serverName);
      if (!updated) {
        return;
      }
      const draft = this.draft(updated);
      draft.credential = { kind: "editing", value: "" };
      draft.credentialFingerprint = updated.credentialFingerprint;
      draft.message = t("platformClaw.mcp.credentialRemoved");
    });
  }
  private async connectOAuth(server: McpServerSetting): Promise<void> {
    await this.mutate(server, async () => {
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
      this.catalog(await this.request(PLATFORMCLAW_MCP_API_PATH));
      const updated = this.servers.find((entry) => entry.serverName === server.serverName);
      if (updated) {
        this.draft(updated).credential = { kind: "stored" };
        this.draft(updated).credentialFingerprint = updated.credentialFingerprint;
        this.draft(updated).message = t("platformClaw.mcp.oauthConnected");
      }
    });
  }
  private consumeOAuthResult(): void {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("mcpOAuth");
    if (result !== "success" && result !== "error") {
      return;
    }
    this.feedback = {
      kind: result === "success" ? "info" : "error",
      message: t(
        result === "success" ? "platformClaw.mcp.oauthConnected" : "platformClaw.mcp.oauthFailed",
      ),
    };
    url.searchParams.delete("mcpOAuth");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
  private renderCredential(server: McpServerSetting, draft: SettingsDraft) {
    if (server.credentialMode !== "personal") {
      return html`<p>
        ${t(
          server.credentialMode === "shared"
            ? "platformClaw.mcp.sharedHelp"
            : "platformClaw.mcp.noCredentialHelp",
        )}
      </p>`;
    }
    if (server.auth === "oauth") {
      return html`<div class="credential">
        <button
          type="button"
          data-action="oauth"
          ?disabled=${this.loading || Boolean(this.busyServer)}
          @click=${() => void this.connectOAuth(server)}
        >
          ${t(server.configured ? "platformClaw.mcp.reconnect" : "platformClaw.mcp.connect")}</button
        >${server.scope
          ? html`<p class="help">${t("platformClaw.mcp.scope", { scope: server.scope })}</p>`
          : nothing}
      </div>`;
    }
    const secret = draft.credential;
    return html`<div class="credential input-line">
      <label
        >${t(
          server.auth === "bearer" ? "platformClaw.mcp.tokenLabel" : "platformClaw.mcp.apiKeyLabel",
          { server: server.serverName },
        )}<input
          name="secret"
          data-secret=${server.serverName}
          type="password"
          autocomplete="new-password"
          maxlength="32768"
          .value=${secret.kind === "editing" ? secret.value : ""}
          placeholder=${secret.kind === "stored" ? t("platformClaw.mcp.storedValue") : ""}
          ?disabled=${this.loading || Boolean(this.busyServer) || secret.kind === "stored"}
          @input=${(event: Event) =>
            this.edit(server, (current) => {
              current.credential = {
                kind: "editing",
                value: (event.target as HTMLInputElement).value,
              };
            })}
      /></label>
      ${secret.kind === "stored"
        ? html`<button
            type="button"
            data-action="change-secret"
            ?disabled=${this.loading || Boolean(this.busyServer)}
            @click=${() =>
              this.edit(server, (current) => {
                current.credential = { kind: "editing", value: "" };
              })}
          >
            ${t("platformClaw.mcp.changeStored")}
          </button>`
        : nothing}
    </div>`;
  }
  private renderHeader(server: McpServerSetting, header: HeaderDraft) {
    const value = header.value;
    const inputId = `mcp-header-${header.id}`;
    const saved = Boolean(header.savedName);
    const canClear = !header.guided || saved || (value.kind === "editing" && Boolean(value.value));
    return html`<div
      class=${header.guided ? "guided-value" : "custom-row"}
      data-header-row=${String(header.id)}
    >
      ${header.guided
        ? html`<label for=${inputId}><strong>${header.name}</strong></label
            >${header.description
              ? html`<p id=${`${inputId}-hint`}>${header.description}</p>`
              : nothing}`
        : html`<label
            >${t("platformClaw.mcp.headerName")}<input
              name="custom-name"
              .value=${header.name}
              ?readonly=${saved}
              ?disabled=${this.loading || Boolean(this.busyServer)}
              @input=${(event: Event) =>
                this.edit(server, () => {
                  header.name = (event.target as HTMLInputElement).value;
                })}
          /></label>`}
      <div class="input-line">
        <input
          id=${inputId}
          name=${header.guided ? "guide-value" : "custom-value"}
          type="password"
          autocomplete="new-password"
          maxlength="32768"
          aria-label=${t("platformClaw.mcp.headerValueLabel", {
            header: header.name || t("platformClaw.mcp.newHeader"),
          })}
          aria-describedby=${header.description ? `${inputId}-hint` : nothing}
          .value=${value.kind === "editing" ? value.value : ""}
          placeholder=${t(
            value.kind === "stored"
              ? "platformClaw.mcp.storedValue"
              : value.kind === "deleted"
                ? "platformClaw.mcp.pendingRemoval"
                : "platformClaw.mcp.optionalValue",
          )}
          ?disabled=${this.loading || Boolean(this.busyServer) || value.kind !== "editing"}
          @input=${(event: Event) =>
            this.edit(server, () => {
              header.value = { kind: "editing", value: (event.target as HTMLInputElement).value };
            })}
        />
        ${value.kind === "stored"
          ? html`<button
              type="button"
              data-action="change-header"
              ?disabled=${this.loading || Boolean(this.busyServer)}
              @click=${() =>
                this.edit(server, () => {
                  header.value = { kind: "editing", value: "" };
                })}
            >
              ${t("platformClaw.mcp.changeStored")}
            </button>`
          : nothing}
      </div>
      ${canClear
        ? html`<button
            type="button"
            data-action="remove-header"
            ?disabled=${this.loading || Boolean(this.busyServer)}
            aria-label=${t("platformClaw.mcp.removeHeaderLabel", {
              header: header.name || t("platformClaw.mcp.newHeader"),
            })}
            @click=${() =>
              this.edit(server, (draft) => {
                if (header.savedName) {
                  header.value = { kind: "deleted" };
                } else if (header.guided) {
                  header.value = { kind: "editing", value: "" };
                } else {
                  draft.headers = draft.headers.filter((entry) => entry.id !== header.id);
                }
              })}
          >
            ${t(
              !header.guided
                ? "platformClaw.mcp.removeHeader"
                : saved
                  ? "platformClaw.mcp.deleteStored"
                  : "platformClaw.mcp.clearValue",
            )}
          </button>`
        : nothing}
    </div>`;
  }
  private renderDetail() {
    const server = this.servers.find((entry) => entry.serverName === this.selection.selected);
    if (!server) {
      return html`<p class="empty">${t("platformClaw.mcp.selectServer")}</p>`;
    }
    const draft = this.draft(server);
    const busy = this.loading || Boolean(this.busyServer);
    return html`<form
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void this.save(server);
      }}
    >
      <div class="editor-title">
        <h3>${t("platformClaw.mcp.myServerSettings", { server: server.serverName })}</h3>
        <small>${t("platformClaw.mcp.organizationPersonalInputs")}</small>
      </div>
      ${!server.globalEnabled
        ? html`<p class="warning">${t("platformClaw.mcp.disabledByAdminHelp")}</p>`
        : nothing}
      ${server.headerError
        ? html`<p class="warning" role="alert">${server.headerError}</p>`
        : nothing}
      ${this.renderCredential(server, draft)}
      <section class="section">
        <h3>
          ${t("platformClaw.mcp.additionalHeaders")}
          <span class="optional">${t("platformClaw.mcp.optional")}</span>
        </h3>
        <p>${t("platformClaw.mcp.additionalHeadersHelp")}</p>
        ${draft.headers.map((header) => this.renderHeader(server, header))}
        <button
          type="button"
          data-action="add-header"
          ?disabled=${busy}
          @click=${() =>
            this.edit(server, (current) => {
              current.headers.push({
                id: ++this.nextHeaderId,
                name: "",
                guided: false,
                value: { kind: "editing", value: "" },
              });
            })}
        >
          ${t("platformClaw.mcp.addHeader")}
        </button>
        <p class="help">${t("platformClaw.mcp.blankHeadersOmitted")}</p>
      </section>
      <div class="actions">
        <button class="primary" type="submit" data-action="save" ?disabled=${busy}>
          ${t("platformClaw.mcp.save")}</button
        ><button
          type="button"
          data-action="cancel"
          ?disabled=${busy}
          @click=${() => {
            this.drafts.delete(server.serverName);
            this.requestUpdate();
          }}
        >
          ${t("platformClaw.mcp.cancelChanges")}
        </button>
        ${server.credentialStored
          ? html`<button
              class="danger"
              type="button"
              data-action="remove"
              ?disabled=${busy}
              @click=${() => void this.removeCredential(server)}
            >
              ${t("platformClaw.mcp.removeCredential")}
            </button>`
          : nothing}
      </div>
      ${draft.error || draft.message
        ? html`<p class="message" role=${draft.error ? "alert" : "status"} aria-live="polite">
            ${draft.error || draft.message}
          </p>`
        : nothing}
    </form>`;
  }
  protected override render() {
    return html`<div class="heading">
        <div>
          <h2>${t("platformClaw.mcp.myConnections")}</h2>
          <p>${t("platformClaw.mcp.personalIntro")}</p>
        </div>
        <button
          type="button"
          data-action="refresh"
          ?disabled=${this.loading || Boolean(this.busyServer)}
          title=${t("platformClaw.mcp.reloadHelp")}
          @click=${() => void this.refresh(true)}
        >
          ${t("platformClaw.mcp.reloadSaved")}
        </button>
      </div>
      ${this.feedback
        ? html`<div class="message" role=${this.feedback.kind === "info" ? "status" : "alert"}>
            <p>
              ${this.feedback.serverName
                ? html`<strong>${this.feedback.serverName}: </strong>`
                : nothing}${this.feedback.message}
            </p>
            ${this.feedback.serverName
              ? html`<button
                  type="button"
                  data-action="show-feedback-server"
                  @click=${() => {
                    this.selection = {
                      ...createMcpCatalogSelection(),
                      selected: this.feedback?.serverName ?? null,
                    };
                    const index = this.rows().findIndex(
                      (row) => row.id === this.selection.selected,
                    );
                    this.selection = {
                      ...this.selection,
                      page: Math.max(0, Math.floor(index / 6)),
                    };
                  }}
                >
                  ${t("platformClaw.mcp.showSettings")}
                </button>`
              : nothing}
          </div>`
        : nothing}
      ${renderMcpWorkspace({
        rows: this.rows(),
        selection: this.selection,
        admin: false,
        busy: this.loading || Boolean(this.busyServer),
        loading: this.loading,
        detail: this.renderDetail(),
        onSelect: (id) => {
          this.selection = { ...this.selection, selected: id, picking: false };
        },
        onToggle: (id, enabled) => void this.toggle(id, enabled),
        onFilter: (patch) => this.filter(patch),
      })}`;
  }
}
if (!customElements.get("platformclaw-mcp-settings")) {
  customElements.define("platformclaw-mcp-settings", PlatformClawMcpSettingsElement);
}
