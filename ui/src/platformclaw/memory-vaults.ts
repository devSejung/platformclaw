import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  KnowledgeVault,
  KnowledgeVaultCatalogEntry,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "./memory-vaults.css";
import "./memory-vault-graph.ts";
import "./memory-vault-author.ts";
import { loadPlatformClawLocale, platformClawT } from "./i18n.ts";
import { renderVaultAccessRequestForm, renderVaultRequests } from "./memory-vault-access.ts";
import type { VaultAuthorSaved } from "./memory-vault-author.ts";
import {
  renderVaultCatalog,
  renderVaultSearch,
  type VaultCatalogTab,
} from "./memory-vault-catalog.ts";
import "./memory-vault-reader.ts";
import "./memory-vault-recovery.ts";
import { renderVaultCreateForm } from "./memory-vault-forms.ts";
import {
  deleteAttachmentLifecycle,
  deleteVaultLifecycle,
  downloadAttachment,
  downloadVaultBlob,
  importVaultArchive,
  renameVaultLifecycle,
  replaceAttachment,
  renderAttachmentDeleteConfirmation,
  renderVaultArchiveImport,
  renderVaultAttachments,
  renderVaultDeleteConfirmation,
  renderVaultManagementActions,
  renderVaultRenameForm,
  renderVaultSelectedLayout,
  renderVaultStateDialog,
  requestVaultBinary,
  uploadAttachment,
} from "./memory-vault-management.ts";
import type { VaultReaderSelection } from "./memory-vault-reader.ts";
import type { VaultUploadSummary } from "./memory-vault-upload.ts";

const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
const RPC = "platformclaw.vault.";

class PlatformClawMemoryVaults extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) methodAdvertised = false;
  @property({ attribute: false }) methods: readonly string[] = [];
  @property() agentId: string | null = null;
  @state() private snapshot: KnowledgeVaultSnapshot = {
    vaults: [],
    selectionRevision: 0,
    ownRequests: [],
    pendingRequests: [],
  };
  @state() private selectedId = "";
  @state() private reader: VaultReaderSelection | null = null;
  @property() initialVaultId = "";
  @property() initialDocumentId = "";
  @state() private authorOpen = false;
  @state() private authorSource: "write" | "upload" = "write";
  @state() private creating = false;
  @state() private busy = false;
  @state() private error = "";
  @state() private message = "";
  @state() private catalogTab: VaultCatalogTab = "mine";
  @state() private catalogQuery = "";
  @state() private searchScope: "connected" | "all" | "selected" = "connected";
  @state() private membersOpen = false;
  @state() private importing = false;
  @state() private renaming = false;
  @state() private deletingVault = false;
  @state() private deletingAttachment: { path: string; revision: number | string } | null = null;
  @state() private requestVault: KnowledgeVaultCatalogEntry | null = null;
  @state() private recoveryVault: KnowledgeVaultCatalogEntry | null = null;
  @state() private publishLookup: string | null = null;
  private epoch = 0;
  private importRefreshPending = false;

  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }
  override disconnectedCallback() {
    this.epoch++;
    this.importRefreshPending = false;
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues) {
    const identityChanged = ["client", "agentId"].some((key) => changed.has(key));
    if (identityChanged || (changed.has("methodAdvertised") && !this.methodAdvertised)) {
      this.epoch++;
      this.snapshot = { vaults: [], selectionRevision: 0, ownRequests: [], pendingRequests: [] };
      this.selectedId = "";
      this.reader = null;
      this.authorOpen = false;
      this.busy = false;
      this.error = "";
      this.message = "";
      this.creating =
        this.membersOpen =
        this.importing =
        this.renaming =
        this.deletingVault =
          false;
      this.deletingAttachment = null;
      this.requestVault = null;
      this.recoveryVault = null;
      this.publishLookup = null;
      this.searchScope = "connected";
    }
    if (["client", "connected", "agentId", "methodAdvertised"].some((key) => changed.has(key))) {
      this.epoch++;
      this.importRefreshPending = false;
      this.busy = false;
      if (!this.connected) {
        this.creating =
          this.membersOpen =
          this.importing =
          this.renaming =
          this.deletingVault =
            false;
        this.deletingAttachment = null;
        this.requestVault = this.recoveryVault = null;
      }
      if (this.available) {
        const epoch = this.epoch;
        void this.run(() => this.readSnapshot(this.selectedId || this.initialVaultId)).then(() => {
          if (
            identityChanged &&
            epoch === this.epoch &&
            this.initialDocumentId &&
            this.selected?.vault.id === this.initialVaultId
          ) {
            this.searchScope = "selected";
            this.openDocument(this.initialDocumentId);
          }
        });
      }
    }
  }
  private get available() {
    return this.client && this.connected && this.methodAdvertised;
  }
  private get selected() {
    return this.snapshot.selected;
  }
  private get canAuthor() {
    return (
      this.methods.includes(`${RPC}document.save`) &&
      this.methods.includes(`${RPC}document.preview`)
    );
  }
  private documentVault(vaultId: string) {
    return this.selected?.vault.id === vaultId
      ? this.selected.vault
      : this.snapshot.vaults.find((vault) => vault.id === vaultId);
  }
  private async run(action: () => Promise<void>, clearMessage = true) {
    if (!this.available || this.busy) {
      return;
    }
    const epoch = this.epoch;
    this.busy = true;
    this.error = "";
    if (clearMessage) {
      this.message = "";
    }
    try {
      await action();
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        if (this.importRefreshPending) {
          this.refreshAfterImport();
        }
      }
    }
  }
  private refreshAfterImport() {
    // Several uploads can finish while one catalog request is still in flight.
    // Keep one trailing refresh so its response includes the latest completion.
    this.importRefreshPending = true;
    if (!this.available || this.busy) {
      return;
    }
    this.importRefreshPending = false;
    void this.run(() => this.readSnapshot(), false);
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
    this.reader = null;
    this.authorOpen = false;
    return this.run(async () => {
      const epoch = this.epoch;
      // An ACL rejection must remove previously visible vault contents.
      this.snapshot = { ...this.snapshot, selected: undefined };
      try {
        await this.readSnapshot(id);
      } catch (error) {
        if (epoch === this.epoch) {
          this.selectedId = "";
          this.searchScope = "connected";
        }
        throw error;
      }
    });
  }
  private async mutate(name: string, params: Record<string, unknown>, message = "operationDone") {
    const epoch = this.epoch;
    await this.client!.request(`${RPC}${name}`, params);
    if (epoch !== this.epoch) {
      return;
    }
    this.authorOpen = false;
    this.reader = null;
    this.message = t(message);
    await this.readSnapshot();
  }
  private openDocument(documentId: string, vaultId = this.selectedId) {
    this.reader = { vaultId, documentId, vault: this.documentVault(vaultId) };
  }
  private openVault(vault: KnowledgeVaultCatalogEntry) {
    if (this.busy) {
      return;
    }
    if (!vault.canRead) {
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
      this.requestVault = null;
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
  private saved(event: CustomEvent<VaultAuthorSaved>, open = true) {
    const result = event.detail;
    this.authorOpen = false;
    this.publishLookup = null;
    if (open) {
      this.reader = {
        vaultId: result.vaultId,
        documentId: result.document.id,
        document: result.document,
        vault: this.documentVault(result.vaultId),
      };
    }
    this.message = `${result.document.title} · ${result.vaultName} — ${t(result.published ? "published" : "saved")}`;
    void this.run(() => this.readSnapshot(), false);
  }
  private renderAuthor() {
    return (this.authorOpen && this.selected) || this.publishLookup
      ? html`<platformclaw-vault-author
          .client=${this.client}
          .connected=${this.connected}
          .agentId=${this.agentId}
          .vault=${this.publishLookup ? null : (this.selected?.vault ?? null)}
          .initialPersonalLookup=${this.publishLookup}
          .initialSourceKind=${this.publishLookup ? "write" : this.authorSource}
          .methods=${this.methods}
          @author-close=${() => {
            this.authorOpen = false;
            this.publishLookup = null;
          }}
          @author-saved=${(event: CustomEvent<VaultAuthorSaved>) => this.saved(event)}
          @author-imported=${(event: CustomEvent<VaultUploadSummary>) => {
            const { saved, unchanged, failed, excluded } = event.detail;
            this.message = platformClawT("platformClaw.vault.importCounts", {
              saved: String(saved),
              unchanged: String(unchanged),
              failed: String(failed),
              excluded: String(excluded),
            });
            this.refreshAfterImport();
          }}
        ></platformclaw-vault-author>`
      : nothing;
  }
  private renderDocument() {
    return this.reader && !this.publishLookup
      ? html`<platformclaw-vault-reader
          .client=${this.client}
          .connected=${this.connected}
          .refreshing=${this.busy}
          .agentId=${this.agentId}
          .methods=${this.methods}
          .selection=${this.reader}
          @reader-deleted=${() => {
            this.reader = null;
            this.message = t("documentDeleted");
            void this.run(() => this.readSnapshot(), false);
          }}
          @reader-publish=${(event: CustomEvent<string>) => (this.publishLookup = event.detail)}
          @reader-close=${() => (this.reader = null)}
          @reader-saved=${(event: CustomEvent<VaultAuthorSaved>) => this.saved(event, false)}
        ></platformclaw-vault-reader>`
      : nothing;
  }
  private renderMembers() {
    return this.selected?.vault.canManageMembers
      ? html`<platformclaw-vault-access
          .client=${this.client}
          .selected=${this.selected}
          .busy=${this.busy}
          @vault-access-mutate=${(
            event: CustomEvent<{ method: string; params: Record<string, unknown> }>,
          ) => void this.run(() => this.mutate(event.detail.method, event.detail.params))}
        ></platformclaw-vault-access>`
      : nothing;
  }
  private renderRequest() {
    const vault = this.requestVault!;
    return renderVaultAccessRequestForm({
      vaultName: vault.name,
      busy: this.busy,
      onSubmit: (role, reason) => {
        void this.run(async () => {
          await this.mutate("access.request", { vaultId: vault.id, role, reason }, "requestSent");
          this.requestVault = null;
        });
      },
    });
  }
  private renderRename() {
    const vault = this.selected!.vault;
    return renderVaultRenameForm({
      vault,
      busy: this.busy,
      onCancel: () => (this.renaming = false),
      onSubmit: (name) => {
        const epoch = this.epoch;
        void this.run(() =>
          renameVaultLifecycle({
            client: this.client!,
            vaultId: vault.id,
            name,
            isCurrent: () => epoch === this.epoch,
            refresh: () => this.readSnapshot(vault.id),
            onRenamed: () => {
              this.renaming = false;
              this.message = t("vaultRenamed");
            },
          }),
        );
      },
    });
  }
  private renderDeleteVault() {
    const vault = this.selected!.vault;
    return renderVaultDeleteConfirmation({
      vault,
      busy: this.busy,
      onCancel: () => (this.deletingVault = false),
      onConfirm: () => {
        const epoch = this.epoch;
        void this.run(() =>
          deleteVaultLifecycle({
            client: this.client!,
            vaultId: vault.id,
            isCurrent: () => epoch === this.epoch,
            onDeleted: () => {
              this.deletingVault = false;
              this.selectedId = "";
              this.reader = null;
              this.searchScope = "connected";
              this.snapshot = { ...this.snapshot, selected: undefined };
              this.message = t("vaultDeleted");
            },
            refreshCatalog: () => this.readSnapshot(""),
          }),
        );
      },
    });
  }
  private renderDeleteAttachment() {
    const vault = this.selected!.vault;
    const attachment = this.deletingAttachment!;
    return renderAttachmentDeleteConfirmation({
      path: attachment.path,
      busy: this.busy,
      onCancel: () => (this.deletingAttachment = null),
      onConfirm: () => {
        const epoch = this.epoch;
        void this.run(() =>
          deleteAttachmentLifecycle({
            binary: requestVaultBinary,
            vaultId: vault.id,
            attachment,
            isCurrent: () => epoch === this.epoch,
            refresh: () => this.readSnapshot(vault.id),
            onDeleted: () => {
              this.deletingAttachment = null;
              this.message = t("attachmentDeleted");
            },
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
    const management = renderVaultManagementActions({
      selected,
      methods: this.methods,
      busy: this.busy,
      authorOpen: this.authorOpen,
      onMembers: () => (this.membersOpen = true),
      onExport: () =>
        void this.run(async () => {
          const epoch = this.epoch;
          const response = await requestVaultBinary(`/export?${query}`);
          const archive = await response.blob();
          if (epoch === this.epoch) {
            downloadVaultBlob(archive, `${vault.name}.zip`);
          }
        }),
      onRebuild: () => void this.run(() => this.mutate("rebuild", { vaultId: vault.id })),
      onRename: () => (this.renaming = true),
      onDelete: () => (this.deletingVault = true),
    });
    const attachments = renderVaultAttachments({
      selected,
      busy: this.busy,
      authorOpen: this.authorOpen,
      run: (action) => this.run(action),
      onUpload: (file) => {
        const epoch = this.epoch;
        return uploadAttachment({
          binary: requestVaultBinary,
          vaultId: vault.id,
          file,
          isCurrent: () => epoch === this.epoch,
          refresh: () => this.readSnapshot(),
        });
      },
      onDownload: (attachment) => {
        const epoch = this.epoch;
        void this.run(() =>
          downloadAttachment({
            binary: requestVaultBinary,
            vaultId: vault.id,
            attachment,
            isCurrent: () => epoch === this.epoch,
            download: downloadVaultBlob,
          }),
        );
      },
      onReplace: (attachment, file) => {
        const epoch = this.epoch;
        return replaceAttachment({
          binary: requestVaultBinary,
          vaultId: vault.id,
          attachment,
          file,
          isCurrent: () => epoch === this.epoch,
          refresh: () => this.readSnapshot(vault.id),
          onReplaced: () => (this.message = t("attachmentReplaced")),
        });
      },
      onDelete: (attachment) =>
        (this.deletingAttachment = { path: attachment.path, revision: attachment.revision }),
    });
    return renderVaultSelectedLayout({
      selected,
      busy: this.busy,
      authorOpen: this.authorOpen,
      canAuthor: this.canAuthor,
      management,
      search: this.renderSearch(),
      attachments,
      onBack: () => {
        this.selectedId = "";
        this.reader = null;
        this.snapshot = { ...this.snapshot, selected: undefined };
        this.searchScope = "connected";
      },
      onAddKnowledge: () => {
        this.authorSource = "write";
        this.authorOpen = true;
      },
      onUploadDocuments:
        vault.type === "personal" && this.methods.includes(`${RPC}document.import`)
          ? () => {
              this.authorSource = "upload";
              this.authorOpen = true;
            }
          : undefined,
      onDocumentOpen: (documentId) => this.openDocument(documentId),
    });
  }
  private renderImport() {
    return renderVaultArchiveImport({
      disabled: this.busy || this.authorOpen,
      onImport: (file) =>
        void this.run(async () => {
          const epoch = this.epoch;
          const vault = await importVaultArchive(file);
          if (epoch !== this.epoch) {
            return;
          }
          this.importing = false;
          this.selectedId = vault.id;
          this.searchScope = "selected";
          await this.readSnapshot(vault.id);
          this.message = t("importedNotice");
        }),
    });
  }
  private renderDialog() {
    return renderVaultStateDialog({
      creating: this.creating,
      membersOpen: this.membersOpen,
      importing: this.importing,
      renaming: this.renaming,
      deletingVault: this.deletingVault,
      deletingAttachment: Boolean(this.deletingAttachment),
      requestingAccess: Boolean(this.requestVault),
      busy: this.busy,
      error: this.error,
      create: this.creating ? this.renderCreate() : nothing,
      members: this.membersOpen ? this.renderMembers() : nothing,
      importVault: this.importing ? this.renderImport() : nothing,
      rename: this.renaming ? this.renderRename() : nothing,
      deleteVault: this.deletingVault ? this.renderDeleteVault() : nothing,
      deleteAttachment: this.deletingAttachment ? this.renderDeleteAttachment() : nothing,
      requestAccess: this.requestVault ? this.renderRequest() : nothing,
      onClose: () => {
        this.creating =
          this.membersOpen =
          this.importing =
          this.renaming =
          this.deletingVault =
            false;
        this.deletingAttachment = null;
        this.requestVault = null;
        this.error = "";
      },
    });
  }
  private renderSearch() {
    return renderVaultSearch({
      client: this.client,
      connected: this.connected,
      agentId: this.agentId,
      scope: this.searchScope,
      vaultId: this.selected?.vault.id ?? null,
      revision: this.snapshot.selectionRevision,
      methods: this.methods,
      onScope: (scope) => (this.searchScope = scope),
      onOpen: (vaultId, documentId) => this.openDocument(documentId, vaultId),
    });
  }
  override render() {
    if (
      !this.client ||
      !this.methodAdvertised ||
      (!this.connected && !this.snapshot.vaults.length)
    ) {
      return html`<p role="status">${t("unavailable")}</p>`;
    }
    return html`<div class="vaults">
      ${!this.connected
        ? html`<p role="status">${platformClawT("memoryPage.memories.offline")}</p>`
        : nothing}
      <div ?inert=${!this.connected}>
        ${this.error ? html`<p class="callout danger" role="alert">${this.error}</p>` : nothing}
        ${this.message
          ? html`<p class="callout success" role="status">${this.message}</p>`
          : nothing}
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
              requestCount:
                this.snapshot.pendingRequests.length +
                this.snapshot.ownRequests.filter((request) => request.status === "pending").length,
              pendingVaultIds: new Set(
                this.snapshot.ownRequests
                  .filter((request) => request.status === "pending")
                  .map((request) => request.vaultId),
              ),
              requestsContent: renderVaultRequests({
                own: this.snapshot.ownRequests,
                pending: this.snapshot.pendingRequests,
                busy: this.busy,
                onCancel: (requestId) =>
                  void this.run(() => this.mutate("access.cancel", { requestId })),
                onDecide: (requestId, decision) =>
                  void this.run(() => this.mutate("access.decide", { requestId, decision })),
              }),
              onRequest: (vault) => (this.requestVault = vault),
              onRecover: (vault) => (this.recoveryVault = vault),
              onCreate: () => (this.creating = true),
              onImport: () => (this.importing = true),
            })}
        ${!this.selected && this.catalogTab !== "requests" ? this.renderSearch() : nothing}
        ${this.recoveryVault
          ? html`<platformclaw-vault-recovery
              .client=${this.client}
              .vault=${this.recoveryVault}
              @recovery-close=${() => (this.recoveryVault = null)}
              @recovery-saved=${() => {
                this.recoveryVault = null;
                this.message = t("ownerRecovered");
                void this.run(() => this.readSnapshot(), false);
              }}
            ></platformclaw-vault-recovery>`
          : nothing}
        ${this.renderDialog()}
      </div>
      ${this.renderAuthor()}${this.renderDocument()}
    </div>`;
  }
}
if (!customElements.get("platformclaw-memory-vaults")) {
  customElements.define("platformclaw-memory-vaults", PlatformClawMemoryVaults);
}
