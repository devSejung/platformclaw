import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  KnowledgeVault,
  KnowledgeVaultCatalogEntry,
  KnowledgeVaultDocument,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "./memory-vaults.css";
import "./memory-vault-graph.ts";
import { loadPlatformClawLocale, platformClawT } from "./i18n.ts";
import {
  renderVaultCatalog,
  renderVaultDialog,
  renderVaultSearch,
  type VaultCatalogTab,
} from "./memory-vault-catalog.ts";
import { renderVaultDocument } from "./memory-vault-document.ts";
import {
  renderVaultCreateForm,
  renderVaultEditorForm,
  renderVaultMembersForm,
  type VaultDraft,
} from "./memory-vault-forms.ts";

const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
const RPC = "platformclaw.vault.";
const API = "/platformclaw/vaults";

type PublishSource = { lookup: string; title: string; sourceContent: string; revision: string };

class PlatformClawMemoryVaults extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) methodAdvertised = false;
  @property() agentId: string | null = null;
  @state() private snapshot: KnowledgeVaultSnapshot = { vaults: [], selectionRevision: 0 };
  @state() private selectedId = "";
  @state() private document: KnowledgeVaultDocument | null = null;
  @state() private draft: VaultDraft | null = null;
  @state() private source: PublishSource | null = null;
  @state() private publishing = false;
  @state() private creating = false;
  @state() private busy = false;
  @state() private error = "";
  @state() private message = "";
  @state() private catalogTab: VaultCatalogTab = "mine";
  @state() private catalogQuery = "";
  @state() private searchScope: "connected" | "all" | "selected" = "connected";
  @state() private membersOpen = false;
  @state() private importing = false;
  @state() private managedVault: KnowledgeVaultCatalogEntry | null = null;
  private epoch = 0;

  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }
  override disconnectedCallback() {
    this.epoch++;
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues) {
    if (["client", "connected", "agentId", "methodAdvertised"].some((key) => changed.has(key))) {
      this.epoch++;
      this.snapshot = { vaults: [], selectionRevision: 0 };
      this.selectedId = "";
      this.document = null;
      this.draft = null;
      this.source = null;
      this.busy = false;
      this.error = "";
      this.message = "";
      this.creating = this.publishing = this.membersOpen = this.importing = false;
      this.managedVault = null;
      this.searchScope = "connected";
      if (this.available) {
        void this.load();
      }
    }
  }
  private get available() {
    return this.client && this.connected && this.methodAdvertised;
  }
  private get selected() {
    return this.snapshot.selected;
  }
  private async run(action: () => Promise<void>) {
    if (!this.available || this.busy) {
      return;
    }
    const epoch = this.epoch;
    this.busy = true;
    this.error = "";
    this.message = "";
    try {
      await action();
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
      }
    }
  }
  private async readSnapshot(id = this.selectedId) {
    const epoch = this.epoch;
    const response = await this.client!.request<KnowledgeVaultSnapshot>(
      `${RPC}snapshot`,
      id ? { vaultId: id } : {},
    );
    if (epoch !== this.epoch) {
      return;
    }
    this.snapshot = response;
    this.selectedId = response.selected?.vault.id ?? id;
  }
  private load(id = this.selectedId) {
    this.document = null;
    this.source = null;
    this.publishing = false;
    return this.run(async () => {
      // An ACL rejection must remove previously visible vault contents.
      this.snapshot = { ...this.snapshot, selected: undefined };
      await this.readSnapshot(id);
    });
  }
  private async mutate(name: string, params: Record<string, unknown>, message = "operationDone") {
    const epoch = this.epoch;
    await this.client!.request(`${RPC}${name}`, params);
    if (epoch !== this.epoch) {
      return;
    }
    this.draft = null;
    this.source = null;
    this.document = null;
    this.publishing = false;
    this.message = t(message);
    await this.readSnapshot();
  }
  private async openDocument(documentId: string) {
    return this.run(async () => {
      const epoch = this.epoch;
      const document = await this.client!.request<KnowledgeVaultDocument>(`${RPC}document.get`, {
        vaultId: this.selectedId,
        documentId,
      });
      if (epoch === this.epoch) {
        this.document = document;
        await this.updateComplete;
        this.querySelector("[data-vault-document]")?.scrollIntoView?.({ block: "start" });
      }
    });
  }
  private navigateMemory(tab: "wiki" | "organization") {
    this.dispatchEvent(
      new CustomEvent("vault-navigate", { detail: tab, bubbles: true, composed: true }),
    );
  }
  private openVault(vault: KnowledgeVaultCatalogEntry) {
    if (this.busy) {
      return;
    }
    if (vault.type === "managed") {
      this.managedVault = vault;
      return;
    }
    this.selectedId = vault.id;
    this.searchScope = "selected";
    void this.load(vault.id);
  }
  private setConnection(vault: KnowledgeVaultCatalogEntry) {
    void this.run(async () => {
      const epoch = this.epoch;
      const snapshot = await this.client!.request<KnowledgeVaultSnapshot>(RPC + "connection.set", {
        vaultId: vault.id,
        connected: !vault.connected,
      });
      if (epoch !== this.epoch) {
        return;
      }
      this.snapshot = {
        ...snapshot,
        selected: this.selectedId ? snapshot.selected : undefined,
      };
      this.managedVault = null;
      this.message = t(vault.connected ? "disconnectedNotice" : "connectedNotice");
    });
  }
  private form(event: SubmitEvent) {
    event.preventDefault();
    return new FormData(event.currentTarget as HTMLFormElement);
  }
  private field(data: FormData, name: string) {
    const value = data.get(name);
    return typeof value === "string" ? value : "";
  }
  private async binary(path: string, init?: RequestInit) {
    const response = await fetch(`${API}${path}`, { credentials: "same-origin", ...init });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Vault request failed (${response.status})`);
    }
    return response;
  }
  private download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    // Keep the URL alive until the browser has consumed the navigation.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  private fileInput(label: string, accept: string, action: (file: File) => Promise<void>) {
    return html`<label class="btn vaults__upload"
      >${t(label)}<input
        type="file"
        accept=${accept}
        ?disabled=${this.busy || Boolean(this.draft)}
        @change=${(event: Event) => {
          const input = event.currentTarget as HTMLInputElement;
          const file = input.files?.[0];
          input.value = "";
          if (file) {
            void this.run(() => action(file));
          }
        }}
    /></label>`;
  }
  private renderCreate() {
    return renderVaultCreateForm({
      busy: this.busy,
      onCancel: () => (this.creating = false),
      onSubmit: (event) => {
        const data = this.form(event);
        void this.run(async () => {
          const epoch = this.epoch;
          const vault = await this.client!.request<KnowledgeVault>(RPC + "create", {
            name: this.field(data, "name"),
            description: this.field(data, "description"),
          });
          if (epoch !== this.epoch) {
            return;
          }
          this.creating = false;
          this.selectedId = vault.id;
          this.searchScope = "selected";
          await this.readSnapshot(vault.id);
          this.message = t("createdNotice");
        });
      },
    });
  }
  private renderEditor() {
    const draft = this.draft!;
    return renderVaultEditorForm({
      draft,
      busy: this.busy,
      onCancel: () => (this.draft = null),
      onSubmit: (event) => {
        const data = this.form(event);
        // Textareas normalize CRLF. Keep source bytes when displayed text was not edited.
        const submitted = this.field(data, "content");
        const content =
          submitted === draft.content.replace(/\r\n?/gu, "\n") ? draft.content : submitted;
        const next = {
          ...draft,
          title: this.field(data, "title"),
          logicalPath: this.field(data, "path"),
          content,
        };
        this.draft = next;
        void this.run(() =>
          this.mutate("document.save", { vaultId: this.selectedId, ...next }, "saved"),
        );
      },
    });
  }
  private renderDocument() {
    const document = this.document;
    if (!document || this.draft || !this.selected) {
      return nothing;
    }
    return renderVaultDocument({
      document,
      vaultName: this.selected.vault.name,
      canEdit: this.selected.vault.canEdit,
      busy: this.busy,
      onOpen: (id) => void this.openDocument(id),
      onEdit: () => {
        this.draft = {
          documentId: document.id,
          expectedRevision: document.revision,
          title: document.title,
          logicalPath: document.logicalPath,
          content: document.content,
        };
      },
      onDownload: () =>
        this.download(
          new Blob([document.content], { type: "text/markdown;charset=utf-8" }),
          document.logicalPath.split("/").at(-1)!,
        ),
      onClose: () => {
        this.document = null;
      },
    });
  }
  private renderPublish() {
    if (!this.publishing) {
      return nothing;
    }
    return html`<section class="vaults__form">
      <p>${t("publishHint")}</p>
      <form
        class="vaults__form"
        @submit=${(event: SubmitEvent) => {
          const data = this.form(event);
          const lookup = this.field(data, "lookup");
          this.source = null;
          void this.run(async () => {
            const epoch = this.epoch;
            const value = await this.client!.request<{
              title: string;
              sourceContent?: string;
              truncated?: boolean;
            }>("wiki.document.get", { agentId: this.agentId, lookup });
            if (epoch !== this.epoch) {
              return;
            }
            if (value.sourceContent === undefined || value.truncated) {
              throw new Error(t("sourceUnavailable"));
            }
            if (!globalThis.crypto?.subtle) {
              throw new Error(t("secureContext"));
            }
            // Publish pins the full reviewed source, not the editable-body revision.
            const digest = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(value.sourceContent),
            );
            if (epoch !== this.epoch) {
              return;
            }
            const revision = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            this.source = {
              lookup,
              title: value.title,
              sourceContent: value.sourceContent,
              revision,
            };
          });
        }}
      >
        <label>${t("sourcePath")}<input class="settings-input" name="lookup" required /></label
        ><button class="btn" ?disabled=${this.busy}>${t("previewSource")}</button>
      </form>
      ${this.source
        ? html`<form
            class="vaults__form"
            @submit=${(event: SubmitEvent) => {
              const data = this.form(event);
              const source = this.source!;
              void this.run(() =>
                this.mutate(
                  "publish",
                  {
                    lookup: source.lookup,
                    expectedRevision: source.revision,
                    targetVaultId: this.selectedId,
                    path: this.field(data, "path"),
                  },
                  "published",
                ),
              );
            }}
          >
            <h4>${this.source.title}</h4>
            <pre class="vaults__source">${this.source.sourceContent}</pre>
            <label
              >${t("path")}<input
                class="settings-input"
                name="path"
                required
                .value=${this.source.lookup} /></label
            ><button class="btn primary" ?disabled=${this.busy}>${t("publishConfirm")}</button>
          </form>`
        : nothing}
      <button
        class="btn"
        ?disabled=${this.busy}
        @click=${() => {
          this.publishing = false;
          this.source = null;
        }}
      >
        ${t("cancel")}
      </button>
    </section>`;
  }
  private renderMembers() {
    const selected = this.selected;
    if (!selected?.vault.canManageMembers) {
      return nothing;
    }
    return renderVaultMembersForm({
      members: selected.members,
      busy: this.busy,
      onRemove: (userId) =>
        void this.run(() => this.mutate("member.remove", { vaultId: this.selectedId, userId })),
      onSubmit: (event) => {
        const data = this.form(event);
        void this.run(() =>
          this.mutate("member.set", {
            vaultId: this.selectedId,
            accountId: this.field(data, "accountId"),
            role: this.field(data, "role"),
            canExport: data.get("canExport") === "on",
          }),
        );
      },
    });
  }
  private renderSelected() {
    const selected = this.selected;
    if (!selected) {
      return nothing;
    }
    const { vault } = selected;
    const query = new URLSearchParams({ vaultId: vault.id });
    return html`<section class="vaults__selected">
      <button
        class="btn btn--sm vaults__back"
        ?disabled=${this.busy}
        @click=${() => {
          this.selectedId = "";
          this.document = null;
          this.snapshot = { ...this.snapshot, selected: undefined };
          this.searchScope = "connected";
        }}
      >
        ${t("backToVaults")}
      </button>
      <header>
        <h2>${vault.name}</h2>
        <p>${vault.description}</p>
        <p class="muted">Shared · ${vault.role} · ${vault.id}</p>
      </header>
      <div class="vaults__actions">
        ${vault.canManageMembers
          ? html`<button class="btn btn--sm" @click=${() => (this.membersOpen = true)}>
              ${t("members")}
            </button>`
          : nothing}
        ${vault.canExport
          ? html`<button
              class="btn"
              ?disabled=${this.busy || Boolean(this.draft)}
              @click=${() =>
                void this.run(async () => {
                  const epoch = this.epoch;
                  const response = await this.binary(`/export?${query}`);
                  const archive = await response.blob();
                  if (epoch === this.epoch) {
                    this.download(archive, `${vault.name}.zip`);
                  }
                })}
            >
              ${t("export")}
            </button>`
          : nothing}
        ${vault.canEdit
          ? html`<button
              class="btn"
              ?disabled=${this.busy || Boolean(this.draft)}
              @click=${() => void this.run(() => this.mutate("rebuild", { vaultId: vault.id }))}
            >
              ${t("rebuild")}
            </button>`
          : nothing}
      </div>
      <h3>${t("documents")}</h3>
      ${vault.canEdit
        ? html`<div class="vaults__actions">
            <button
              class="btn"
              ?disabled=${this.busy || Boolean(this.draft)}
              @click=${() => (this.draft = { title: "", logicalPath: "", content: "" })}
            >
              ${t("newDocument")}
            </button>
            ${this.fileInput("uploadMarkdown", ".md,.markdown,text/markdown", async (file) => {
              if (file.size > 1024 * 1024) {
                throw new Error(t("tooLarge"));
              }
              const epoch = this.epoch;
              let content: string;
              try {
                content = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(
                  await file.arrayBuffer(),
                );
              } catch {
                throw new Error(t("invalidUtf8"));
              }
              if (epoch === this.epoch) {
                this.draft = {
                  title: file.name.replace(/\.(md|markdown)$/i, ""),
                  logicalPath: file.name,
                  content,
                };
              }
            })}
            <button
              class="btn"
              ?disabled=${this.busy || Boolean(this.draft)}
              @click=${() => (this.publishing = true)}
            >
              ${t("publish")}
            </button>
          </div>`
        : nothing}
      ${this.renderDocument()}
      <platformclaw-vault-documents
        .selected=${selected}
        .busy=${this.busy || Boolean(this.draft)}
        @vault-document-open=${(event: CustomEvent<string>) => void this.openDocument(event.detail)}
      ></platformclaw-vault-documents>
      <details class="card">
        <summary>${t("attachments")}</summary>
        ${vault.canEdit
          ? this.fileInput("uploadAttachment", "", async (file) => {
              if (file.size > 8 * 1024 * 1024) {
                throw new Error(t("tooLarge"));
              }
              const epoch = this.epoch;
              await this.binary(
                `/attachment?${new URLSearchParams({ vaultId: vault.id, path: file.name })}`,
                {
                  method: "PUT",
                  headers: { "Content-Type": file.type || "application/octet-stream" },
                  body: file,
                },
              );
              if (epoch === this.epoch) {
                await this.readSnapshot();
              }
            })
          : nothing}
        ${selected.attachments.map(
          (attachment) =>
            html`<div class="vaults__member">
              <span>${attachment.path} · ${attachment.bytes} bytes · r${attachment.revision}</span
              ><button
                class="btn"
                ?disabled=${this.busy}
                @click=${() =>
                  void this.run(async () => {
                    const epoch = this.epoch;
                    const response = await this.binary(
                      `/attachment?${new URLSearchParams({ vaultId: vault.id, path: attachment.path })}`,
                    );
                    const blob = await response.blob();
                    if (epoch === this.epoch) {
                      this.download(blob, attachment.path.split("/").at(-1)!);
                    }
                  })}
              >
                ${t("downloadAttachment")}
              </button>
            </div>`,
        )}
      </details>
    </section>`;
  }
  private renderImport() {
    return html`<p>${t("importHint")}</p>
      ${this.fileInput("chooseZip", ".zip,application/zip", async (file) => {
        if (file.size > 32 * 1024 * 1024) {
          throw new Error(t("tooLarge"));
        }
        const epoch = this.epoch;
        const response = await this.binary("/import", {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body: file,
        });
        const vault = (await response.json()) as KnowledgeVault;
        if (epoch !== this.epoch) {
          return;
        }
        this.importing = false;
        this.selectedId = vault.id;
        this.searchScope = "selected";
        await this.readSnapshot(vault.id);
        this.message = t("importedNotice");
      })}`;
  }
  private renderDialog() {
    const kind = this.creating
      ? "new"
      : this.draft
        ? "body"
        : this.publishing
          ? "publish"
          : this.membersOpen
            ? "members"
            : this.importing
              ? "import"
              : this.managedVault
                ? "managedTitle"
                : null;
    if (!kind) {
      return nothing;
    }
    const content = this.creating
      ? this.renderCreate()
      : this.draft
        ? this.renderEditor()
        : this.publishing
          ? this.renderPublish()
          : this.membersOpen
            ? this.renderMembers()
            : this.importing
              ? this.renderImport()
              : html`<h3>${this.managedVault!.name}</h3>
                  <p>${t("managed")}</p>
                  <button class="btn primary" @click=${() => this.navigateMemory("organization")}>
                    ${t("openManaged")}
                  </button>`;
    return renderVaultDialog({
      title: t(kind),
      content,
      busy: this.busy,
      error: this.error,
      onClose: () => {
        this.creating = this.publishing = this.membersOpen = this.importing = false;
        this.draft = null;
        this.source = null;
        this.managedVault = null;
        this.error = "";
      },
    });
  }
  override render() {
    if (!this.available) {
      return html`<p role="status">${t("unavailable")}</p>`;
    }
    return html`<div class="vaults">
      ${this.error ? html`<p class="callout danger" role="alert">${this.error}</p>` : nothing}
      ${this.message ? html`<p class="callout success" role="status">${this.message}</p>` : nothing}
      ${this.busy ? html`<p class="vaults__hint" role="status">${t("loading")}</p>` : nothing}
      ${this.selected
        ? this.renderSelected()
        : renderVaultCatalog({
            vaults: this.snapshot.vaults,
            tab: this.catalogTab,
            query: this.catalogQuery,
            busy: this.busy,
            onTab: (tab) => (this.catalogTab = tab),
            onQuery: (query) => (this.catalogQuery = query),
            onOpen: (vault) => this.openVault(vault),
            onConnection: (vault) => this.setConnection(vault),
            onPersonal: () => this.navigateMemory("wiki"),
            onCreate: () => (this.creating = true),
            onImport: () => (this.importing = true),
          })}
      ${renderVaultSearch({
        client: this.client,
        connected: this.connected,
        agentId: this.agentId,
        scope: this.searchScope,
        vaultId: this.selected?.vault.id ?? null,
        revision: this.snapshot.selectionRevision,
        onScope: (scope) => (this.searchScope = scope),
      })}${this.renderDialog()}
    </div>`;
  }
}
if (!customElements.get("platformclaw-memory-vaults")) {
  customElements.define("platformclaw-memory-vaults", PlatformClawMemoryVaults);
}
