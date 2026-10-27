import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { i18n } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import {
  canPreserveSharedMcpSecret,
  createAdminMcpDraft,
  type AdminMcpDraft,
  type AdminMcpServer,
} from "./mcp-administration-model.ts";
import { notifyPlatformClawMcpCatalogChanged } from "./mcp-catalog-events.ts";
import { mcpWorkspaceStyles } from "./mcp-workspace-styles.ts";
import {
  createMcpCatalogSelection,
  renderMcpWorkspace,
  selectMcpCatalogPage,
  type McpCatalogRow,
  type McpCatalogSelection,
} from "./mcp-workspace.ts";
import { PLATFORMCLAW_MCP_ADMIN_API_PATH } from "./web-contract.ts";

class PlatformClawMcpAdministrationElement extends OpenClawLitElement {
  static override styles = mcpWorkspaceStyles;
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => {};
  @property({ attribute: false }) confirmRemove: (message: string) => boolean = (message) =>
    window.confirm(message);
  @state() private servers: AdminMcpServer[] = [];
  @state() private selection = createMcpCatalogSelection();
  @state() private loading = true;
  @state() private busy = false;
  @state() private message = "";
  @state() private editor: { kind: "server" } | { kind: "new"; draft: AdminMcpDraft } = {
    kind: "server",
  };
  private readonly drafts = new Map<string, AdminMcpDraft>();
  private unsubscribeLocale = () => {};
  private generation = 0;
  override connectedCallback(): void {
    super.connectedCallback();
    this.loading = true;
    this.unsubscribeLocale = i18n.subscribe(
      () => void loadPlatformClawLocale().then(() => this.requestUpdate()),
    );
    void loadPlatformClawLocale().then(() => {
      if (this.isConnected) {
        void this.refresh();
      }
    });
  }
  override disconnectedCallback(): void {
    this.generation++;
    this.busy = false;
    this.servers = [];
    this.unsubscribeLocale();
    this.drafts.clear();
    this.editor = { kind: "server" };
    super.disconnectedCallback();
  }
  private async request(body?: Record<string, unknown>): Promise<AdminMcpServer[]> {
    const response = await this.fetchImpl(PLATFORMCLAW_MCP_ADMIN_API_PATH, {
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401) {
      this.onUnauthenticated();
      throw new Error(t("platformClaw.mcp.sessionExpired"));
    }
    const result = (await response.json()) as { servers?: AdminMcpServer[]; error?: string };
    if (!response.ok || !Array.isArray(result.servers)) {
      throw new Error(result.error ?? t("platformClaw.mcp.adminFailed"));
    }
    return result.servers;
  }
  private rows(): McpCatalogRow[] {
    return this.servers.map((server) => ({
      id: server.name,
      name: server.name,
      origin: "organization",
      credentialMode: server.credentialMode,
      enabled: server.enabled,
      globalEnabled: server.enabled,
      configured: true,
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
  private draft(server: AdminMcpServer): AdminMcpDraft {
    let draft = this.drafts.get(server.name);
    if (!draft) {
      draft = createAdminMcpDraft(server);
      this.drafts.set(server.name, draft);
    }
    return draft;
  }
  private edit(draft: AdminMcpDraft, change: () => void): void {
    change();
    draft.error = "";
    draft.message = "";
    this.requestUpdate();
  }
  private async refresh(): Promise<void> {
    if (this.busy) {
      return;
    }
    const generation = ++this.generation;
    this.loading = true;
    try {
      const servers = await this.request();
      if (this.isConnected && generation === this.generation) {
        this.servers = servers;
        this.reconcileSelection();
        this.message = "";
      }
    } catch (error) {
      if (this.isConnected && generation === this.generation) {
        this.message = error instanceof Error ? error.message : t("platformClaw.mcp.adminFailed");
      }
    } finally {
      if (this.isConnected && generation === this.generation) {
        this.loading = false;
      }
    }
  }
  private async mutate(
    body: Record<string, unknown>,
    draft?: AdminMcpDraft,
    saved = false,
  ): Promise<void> {
    if (this.busy || this.loading) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.message = "";
    if (draft) {
      draft.error = "";
      draft.message = "";
    }
    try {
      const servers = await this.request(body);
      if (!this.isConnected || generation !== this.generation) {
        return;
      }
      this.servers = servers;
      if (saved) {
        this.drafts.delete(String(body.name));
        this.editor = { kind: "server" };
        this.selection = {
          ...this.selection,
          search: "",
          policy: "all",
          status: "all",
          selected: String(body.name),
          page: Math.max(
            0,
            Math.floor(servers.findIndex((server) => server.name === body.name) / 6),
          ),
        };
      }
      this.reconcileSelection();
      if (saved) {
        const server = servers.find((entry) => entry.name === body.name);
        if (server) {
          this.draft(server).message = t("platformClaw.mcp.adminSaved");
        }
      } else {
        this.message = t("platformClaw.mcp.permissionSaved");
      }
      notifyPlatformClawMcpCatalogChanged();
    } catch (error) {
      if (this.isConnected && generation === this.generation) {
        const message = error instanceof Error ? error.message : t("platformClaw.mcp.adminFailed");
        if (draft) {
          draft.error = message;
        } else {
          this.message = message;
        }
      }
    } finally {
      if (this.isConnected && generation === this.generation) {
        this.busy = false;
      }
    }
  }
  private async save(draft: AdminMcpDraft, server?: AdminMcpServer): Promise<void> {
    const guides = draft.headerGuides
      .filter((guide) => guide.name.trim() || guide.description?.trim())
      .map((guide) => ({
        name: guide.name.trim(),
        description: guide.description?.trim() || undefined,
      }));
    if (guides.some((guide) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(guide.name))) {
      draft.error = t("platformClaw.mcp.invalidHeader");
      this.requestUpdate();
      return;
    }
    if (new Set(guides.map((guide) => guide.name.toLowerCase())).size !== guides.length) {
      draft.error = t("platformClaw.mcp.duplicateHeader");
      this.requestUpdate();
      return;
    }
    const preserve = canPreserveSharedMcpSecret(server, draft);
    const secret = draft.secret.kind === "editing" ? draft.secret.value : "";
    if (draft.credentialMode === "shared" && !secret && !preserve) {
      draft.error = t("platformClaw.mcp.sharedReplacementRequired");
      this.requestUpdate();
      return;
    }
    await this.mutate(
      {
        action: "save-server",
        name: draft.name,
        url: draft.url,
        transport: draft.transport,
        credentialMode: draft.credentialMode,
        auth: draft.auth,
        headerName: draft.headerName,
        scope: draft.scope,
        headerGuides: guides,
        blockedTools: draft.blockedTools
          .split(/[\n,]/u)
          .map((tool) => tool.trim())
          .filter(Boolean),
        enabled: server?.enabled ?? true,
        ...(draft.credentialMode === "shared" && secret ? { secret } : {}),
      },
      draft,
      true,
    );
  }
  private renderCredential(draft: AdminMcpDraft, server?: AdminMcpServer) {
    const preserve = canPreserveSharedMcpSecret(server, draft);
    const stored = draft.secret.kind === "stored" && preserve;
    return html`${draft.credentialMode === "none"
      ? nothing
      : html`<label
          >${t("platformClaw.mcp.adminAuth")}<select
            name="auth"
            ?disabled=${this.busy || this.loading}
            @change=${(event: Event) =>
              this.edit(draft, () => {
                draft.auth = (event.target as HTMLSelectElement).value as AdminMcpDraft["auth"];
              })}
          >
            <!-- Lit updates select properties before inserting conditional
                 options. Select each option after insertion to show the policy actually saved. -->
            <option value="bearer" .selected=${draft.auth === "bearer"}>Bearer token</option>
            <option value="api_key" .selected=${draft.auth === "api_key"}>API key</option>
            ${draft.credentialMode === "personal"
              ? html`<option value="oauth" .selected=${draft.auth === "oauth"}>OAuth</option>`
              : nothing}
          </select></label
        >`}
    ${draft.credentialMode !== "none" && draft.auth === "api_key"
      ? html`<label
          >${t("platformClaw.mcp.adminHeader")}<input
            name="headerName"
            .value=${draft.headerName}
            ?disabled=${this.busy || this.loading}
            required
            @input=${(event: Event) =>
              this.edit(draft, () => {
                draft.headerName = (event.target as HTMLInputElement).value;
              })}
        /></label>`
      : nothing}
    ${draft.credentialMode === "personal" && draft.auth === "oauth"
      ? html`<label
          >${t("platformClaw.mcp.adminScope")}<input
            name="scope"
            .value=${draft.scope}
            ?disabled=${this.busy || this.loading}
            @input=${(event: Event) =>
              this.edit(draft, () => {
                draft.scope = (event.target as HTMLInputElement).value;
              })}
        /></label>`
      : nothing}
    ${draft.credentialMode === "shared"
      ? html`<div class="input-line wide">
          <label
            >${t("platformClaw.mcp.adminSharedSecret")}<input
              name="secret"
              type="password"
              autocomplete="new-password"
              maxlength="32768"
              .value=${draft.secret.kind === "editing" ? draft.secret.value : ""}
              placeholder=${stored ? t("platformClaw.mcp.storedValue") : ""}
              ?disabled=${this.busy || this.loading || stored}
              ?required=${!preserve}
              @input=${(event: Event) =>
                this.edit(draft, () => {
                  draft.secret = {
                    kind: "editing",
                    value: (event.target as HTMLInputElement).value,
                  };
                })} /></label
          >${stored
            ? html`<button
                type="button"
                data-action="change-secret"
                ?disabled=${this.busy || this.loading}
                @click=${() =>
                  this.edit(draft, () => {
                    draft.secret = { kind: "editing", value: "" };
                  })}
              >
                ${t("platformClaw.mcp.changeStored")}
              </button>`
            : nothing}
        </div>`
      : nothing}`;
  }
  private renderEditor(draft: AdminMcpDraft, server?: AdminMcpServer) {
    return html`<form
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void this.save(draft, server);
      }}
    >
      <div class="editor-title">
        <h3>
          ${server
            ? t("platformClaw.mcp.editServer", { server: server.name })
            : t("platformClaw.mcp.adminAdd")}
        </h3>
        <small>${t("platformClaw.mcp.organizationServer")}</small>
      </div>
      <div class="fields">
        <label
          >${t("platformClaw.mcp.adminName")}<input
            name="name"
            pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
            maxlength="128"
            required
            ?readonly=${Boolean(server)}
            ?disabled=${this.busy || this.loading}
            .value=${draft.name}
            @input=${(event: Event) =>
              this.edit(draft, () => {
                draft.name = (event.target as HTMLInputElement).value;
              })}
        /></label>
        <label
          >${t("platformClaw.mcp.adminUrl")}<input
            name="url"
            type="url"
            maxlength="2048"
            required
            ?disabled=${this.busy || this.loading}
            .value=${draft.url}
            @input=${(event: Event) =>
              this.edit(draft, () => {
                draft.url = (event.target as HTMLInputElement).value;
              })}
        /></label>
        <label
          >${t("platformClaw.mcp.adminTransport")}<select
            name="transport"
            .value=${draft.transport}
            ?disabled=${this.busy || this.loading}
            @change=${(event: Event) =>
              this.edit(draft, () => {
                draft.transport = (event.target as HTMLSelectElement)
                  .value as AdminMcpDraft["transport"];
              })}
          >
            <option value="streamable-http">Streamable HTTP</option>
            <option value="sse">SSE</option>
          </select></label
        >
        <label
          >${t("platformClaw.mcp.adminCredentialMode")}<select
            name="credentialMode"
            .value=${draft.credentialMode}
            ?disabled=${this.busy || this.loading}
            @change=${(event: Event) =>
              this.edit(draft, () => {
                draft.credentialMode = (event.target as HTMLSelectElement)
                  .value as AdminMcpDraft["credentialMode"];
                if (draft.credentialMode !== "personal" && draft.auth === "oauth") {
                  draft.auth = "bearer";
                }
              })}
          >
            <option value="none">${t("platformClaw.mcp.adminNoCredentialShort")}</option>
            <option value="shared">${t("platformClaw.mcp.adminSharedCredential")}</option>
            <option value="personal">${t("platformClaw.mcp.adminPersonalCredential")}</option>
          </select></label
        >
        ${this.renderCredential(draft, server)}
      </div>
      ${draft.credentialMode !== "none" && /^http:\/\//iu.test(draft.url)
        ? html`<p class="warning" data-http-auth-warning role="alert">
            ${t("platformClaw.mcp.adminHttpCredentialWarning")}
          </p>`
        : nothing}
      <section class="section">
        <h3>
          ${t("platformClaw.mcp.headerGuides")}
          <span class="optional">${t("platformClaw.mcp.optional")}</span>
        </h3>
        <p>${t("platformClaw.mcp.headerGuidesHelp")}</p>
        ${draft.headerGuides.map(
          (guide, index) =>
            html`<div class="guide-row">
              <label
                >${t("platformClaw.mcp.headerName")}<input
                  name="guide-name"
                  .value=${guide.name}
                  ?disabled=${this.busy || this.loading}
                  @input=${(event: Event) =>
                    this.edit(draft, () => {
                      guide.name = (event.target as HTMLInputElement).value;
                    })} /></label
              ><label
                >${t("platformClaw.mcp.headerDescription")}<input
                  name="guide-description"
                  maxlength="512"
                  .value=${guide.description ?? ""}
                  ?disabled=${this.busy || this.loading}
                  @input=${(event: Event) =>
                    this.edit(draft, () => {
                      guide.description = (event.target as HTMLInputElement).value;
                    })} /></label
              ><button
                type="button"
                data-action="remove-guide"
                ?disabled=${this.busy || this.loading}
                aria-label=${t("platformClaw.mcp.removeHeaderLabel", {
                  header: guide.name || t("platformClaw.mcp.newHeader"),
                })}
                @click=${() =>
                  this.edit(draft, () => {
                    draft.headerGuides.splice(index, 1);
                  })}
              >
                ${t("platformClaw.mcp.removeHeader")}
              </button>
            </div>`,
        )}
        <button
          type="button"
          data-action="add-header"
          ?disabled=${this.busy || this.loading}
          @click=${() =>
            this.edit(draft, () => {
              draft.headerGuides.push({ name: "", description: "" });
            })}
        >
          ${t("platformClaw.mcp.addHeader")}
        </button>
      </section>
      <details>
        <summary>${t("platformClaw.mcp.toolAccess")}</summary>
        <label
          >${t("platformClaw.mcp.adminBlockedTools")}<textarea
            name="blockedTools"
            rows="3"
            .value=${draft.blockedTools}
            ?disabled=${this.busy || this.loading}
            @input=${(event: Event) =>
              this.edit(draft, () => {
                draft.blockedTools = (event.target as HTMLTextAreaElement).value;
              })}
          ></textarea
          ><span class="help">${t("platformClaw.mcp.adminBlockedToolsHelp")}</span></label
        >
      </details>
      <div class="actions">
        <button class="primary" type="submit" ?disabled=${this.busy || this.loading}>
          ${t("platformClaw.mcp.save")}</button
        ><button
          type="button"
          data-action="cancel"
          ?disabled=${this.busy || this.loading}
          @click=${() => {
            if (server) {
              this.drafts.delete(server.name);
            }
            this.editor = { kind: "server" };
            this.requestUpdate();
          }}
        >
          ${t("platformClaw.mcp.cancelChanges")}</button
        >${server
          ? html`<button
              class="danger"
              type="button"
              data-action="remove"
              ?disabled=${this.busy || this.loading}
              @click=${() => void this.removeServer(server)}
            >
              ${t("platformClaw.mcp.deleteServer")}
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
  private async removeServer(server: AdminMcpServer): Promise<void> {
    if (!this.confirmRemove(t("platformClaw.mcp.adminRemoveConfirm", { server: server.name }))) {
      return;
    }
    await this.mutate({ action: "remove-server", name: server.name });
  }
  private renderDetail() {
    if (this.loading) {
      return html``;
    }
    if (this.editor.kind === "new") {
      return this.renderEditor(this.editor.draft);
    }
    const server = this.servers.find((entry) => entry.name === this.selection.selected);
    if (!server) {
      return html`<p class="empty">${t("platformClaw.mcp.selectServer")}</p>`;
    }
    if (!server.editable) {
      return html`<h3>${server.name}</h3>
        <p>${server.target}</p>
        <p class="warning">${t("platformClaw.mcp.adminCliManaged")}</p>
        <button
          class="danger"
          type="button"
          ?disabled=${this.busy || this.loading}
          @click=${() => void this.removeServer(server)}
        >
          ${t("platformClaw.mcp.deleteServer")}
        </button>`;
    }
    return this.renderEditor(this.draft(server), server);
  }
  protected override render() {
    return html`<div class="heading">
        <div>
          <h2>${t("platformClaw.mcp.adminTitle")}</h2>
          <p>${t("platformClaw.mcp.adminIntro")}</p>
        </div>
        <button
          type="button"
          data-action="add"
          ?disabled=${this.busy || this.loading}
          @click=${() => {
            this.editor = { kind: "new", draft: createAdminMcpDraft() };
            this.selection = { ...this.selection, picking: false };
          }}
        >
          ${t("platformClaw.mcp.adminAdd")}
        </button>
      </div>
      ${this.message ? html`<p class="message" role="status">${this.message}</p>` : nothing}
      ${renderMcpWorkspace({
        rows: this.rows(),
        selection: this.selection,
        admin: true,
        busy: this.busy || this.loading,
        loading: this.loading,
        detail: this.renderDetail(),
        onSelect: (id) => {
          this.editor = { kind: "server" };
          this.selection = { ...this.selection, selected: id, picking: false };
        },
        onToggle: (id, enabled) => void this.mutate({ action: "toggle-server", name: id, enabled }),
        onFilter: (patch) => this.filter(patch),
      })}`;
  }
}
if (!customElements.get("platformclaw-mcp-administration")) {
  customElements.define("platformclaw-mcp-administration", PlatformClawMcpAdministrationElement);
}
