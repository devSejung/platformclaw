import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  KnowledgeVaultDocumentSummary,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT } from "./i18n.ts";
import type {
  VaultDocumentBulkDeleteResult,
  VaultDocumentsBulkDeleted,
} from "./memory-vault-document-bulk-delete.ts";
import type { VaultDocumentPublishSummary } from "./memory-vault-document-bulk-publish.ts";
import "./memory-vault-document-bulk-delete.ts";
import "./memory-vault-document-bulk-publish.ts";
import { renderVaultDocumentList } from "./memory-vault-document.ts";

type SelectedVault = NonNullable<KnowledgeVaultSnapshot["selected"]>;
export type VaultDocumentContext = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentId: string | null;
  methods: readonly string[];
};
const t = (key: string, params?: Record<string, string>) =>
  platformClawT(`platformClaw.vault.${key}`, params);

class PlatformClawVaultDocumentActions extends OpenClawLightDomElement {
  @property({ attribute: false }) selected!: SelectedVault;
  @property({ attribute: false }) context: VaultDocumentContext | null = null;
  @property({ type: Boolean }) busy = false;
  @state() private ids = new Set<string>();
  @state() private deleted = new Set<string>();
  @state() private acting = false;
  @state() private dialog: {
    action: "delete" | "publish";
    documents: KnowledgeVaultDocumentSummary[];
  } | null = null;

  protected override willUpdate(changed: PropertyValues) {
    const previous = changed.get("selected") as SelectedVault | undefined;
    const context = changed.get("context") as VaultDocumentContext | null | undefined;
    const vaultChanged = changed.has("selected") && previous?.vault.id !== this.selected.vault.id;
    const identityChanged =
      changed.has("context") &&
      (context?.client !== this.context?.client || context?.agentId !== this.context?.agentId);
    if (vaultChanged || identityChanged) {
      this.ids = new Set();
      this.deleted = new Set();
      this.dialog = null;
      this.acting = false;
    } else if (changed.has("selected")) {
      const loaded = new Set(this.selected.documents.map((document) => document.id));
      // The parent rejects pre-mutation snapshot responses. A successful new snapshot
      // is authoritative, including a Personal document recreated at the same path.
      this.deleted = new Set();
      this.ids = new Set([...this.ids].filter((id) => loaded.has(id) && !this.deleted.has(id)));
    }
  }
  private changed() {
    this.dispatchEvent(
      new CustomEvent("vault-documents-changed", { bubbles: true, composed: true }),
    );
  }
  private deletedDocuments(event: CustomEvent<VaultDocumentsBulkDeleted>) {
    const detail = event.detail;
    if (
      detail.client !== this.context?.client ||
      detail.agentId !== this.context.agentId ||
      detail.vaultId !== this.selected.vault.id
    ) {
      return;
    }
    this.deleted = new Set([...this.deleted, ...detail.documentIds]);
    this.ids = new Set([...this.ids].filter((id) => !this.deleted.has(id)));
  }
  private close() {
    this.dialog = null;
    this.acting = false;
  }
  override render() {
    const selected = this.selected;
    const context = this.context;
    const documents = selected.documents.filter((document) => !this.deleted.has(document.id));
    const canDelete =
      selected.vault.canEdit &&
      context?.methods.includes("platformclaw.vault.document.get") &&
      context.methods.includes("platformclaw.vault.document.delete");
    const canPublish =
      selected.vault.type === "personal" &&
      selected.vault.canRead &&
      context?.methods.includes("platformclaw.vault.document.get") &&
      context.methods.includes("platformclaw.vault.document.publish");
    const selectable = Boolean(canDelete || canPublish);
    const disabled = this.busy || this.acting || (context !== null && !context.connected);
    const allSelected =
      documents.length > 0 && documents.every((document) => this.ids.has(document.id));
    const open = (action: "delete" | "publish") => {
      this.dialog = {
        action,
        documents: documents.filter((document) => this.ids.has(document.id)),
      };
    };
    return html` ${selected.documentsTruncated
      ? html`<p class="callout" role="status" data-vault-documents-truncated>
          ${t("documentsTruncated", {
            loaded: String(documents.length),
            total: String(selected.documentCount ?? documents.length),
          })}
        </p>`
      : nothing}
    ${selectable
      ? html`<div class="vaults__actions" data-document-selection>
            <button
              class="btn btn--sm"
              ?disabled=${disabled || !documents.length}
              @click=${() => {
                this.ids = allSelected
                  ? new Set()
                  : new Set(documents.map((document) => document.id));
              }}
            >
              ${t(allSelected ? "deselectLoadedDocuments" : "selectLoadedDocuments")}
            </button>
            <span role="status"
              >${t("selectedDocumentCount", {
                selected: String(this.ids.size),
                loaded: String(documents.length),
              })}</span
            >
            ${this.ids.size
              ? html`<button
                  class="btn btn--sm"
                  ?disabled=${disabled}
                  @click=${() => {
                    this.ids = new Set();
                  }}
                >
                  ${t("clearDocumentSelection")}
                </button>`
              : nothing}
            ${canPublish
              ? html`<button
                  class="btn btn--sm primary"
                  ?disabled=${disabled || !this.ids.size}
                  @click=${() => open("publish")}
                >
                  ${t("publishSelectedDocuments")}
                </button>`
              : nothing}
            ${canDelete
              ? html`<button
                  class="btn btn--sm danger"
                  ?disabled=${disabled || !this.ids.size}
                  @click=${() => open("delete")}
                >
                  ${t("deleteSelectedDocuments")}
                </button>`
              : nothing}
          </div>
          <p class="vaults__hint">${t("documentSelectionHint")}</p>`
      : nothing}
    ${renderVaultDocumentList({
      documents,
      vaultName: selected.vault.name,
      vaultType: selected.vault.type,
      canEdit: selected.vault.canEdit,
      busy: disabled,
      onOpen: (id) =>
        this.dispatchEvent(
          new CustomEvent("vault-document-open", { bubbles: true, composed: true, detail: id }),
        ),
      ...(selectable
        ? {
            selection: {
              ids: this.ids,
              onChange: (id: string, checked: boolean) => {
                const ids = new Set(this.ids);
                if (checked) {
                  ids.add(id);
                } else {
                  ids.delete(id);
                }
                this.ids = ids;
              },
            },
          }
        : {}),
    })}
    ${this.dialog?.action === "delete" && context
      ? html`<platformclaw-vault-document-bulk-delete
          .client=${context.client}
          .connected=${context.connected}
          .agentId=${context.agentId}
          .vault=${selected.vault}
          .documents=${this.dialog.documents}
          @document-bulk-busy=${(event: CustomEvent<boolean>) => {
            this.acting = event.detail;
          }}
          @document-bulk-deleted=${(event: CustomEvent<VaultDocumentsBulkDeleted>) =>
            this.deletedDocuments(event)}
          @document-bulk-delete-result=${(_event: CustomEvent<VaultDocumentBulkDeleteResult>) =>
            this.changed()}
          @document-bulk-close=${() => this.close()}
        ></platformclaw-vault-document-bulk-delete>`
      : nothing}
    ${this.dialog?.action === "publish" && context
      ? html`<platformclaw-vault-document-bulk-publish
          .client=${context.client}
          .connected=${context.connected}
          .agentId=${context.agentId}
          .methods=${context.methods}
          .vault=${selected.vault}
          .documents=${this.dialog.documents}
          @document-publish-busy=${(event: CustomEvent<boolean>) => {
            this.acting = event.detail;
          }}
          @document-publish-complete=${(event: CustomEvent<VaultDocumentPublishSummary>) => {
            if (event.detail.vaultId !== this.selected.vault.id) {
              return;
            }
            const confirmed = new Set(event.detail.confirmedDocumentIds);
            this.ids = new Set([...this.ids].filter((id) => !confirmed.has(id)));
            this.changed();
          }}
          @document-publish-close=${() => this.close()}
        ></platformclaw-vault-document-bulk-publish>`
      : nothing}`;
  }
}
if (!customElements.get("platformclaw-vault-document-actions")) {
  customElements.define("platformclaw-vault-document-actions", PlatformClawVaultDocumentActions);
}
