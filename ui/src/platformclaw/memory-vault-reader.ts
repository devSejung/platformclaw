import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, type PropertyValues } from "lit";
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
import { platformClawT } from "./i18n.ts";
import type { VaultAuthorSaved } from "./memory-vault-author.ts";
import "./memory-vault-author.ts";
import { renderVaultDialog } from "./memory-vault-catalog.ts";
import { renderVaultDocument } from "./memory-vault-document.ts";

export type VaultReaderSelection = {
  vaultId: string;
  documentId: string;
  document?: KnowledgeVaultDocument;
  vault?: KnowledgeVault | KnowledgeVaultCatalogEntry;
};
const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);

function findVaultHeading(article: Element, fragment: string): HTMLElement | undefined {
  const target = fragment.toLowerCase();
  const used = new Set<string>();
  const headings = [...article.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")];
  const slugs = headings.map((heading) => {
    const base = (heading.textContent ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "")
      .replace(/\s/g, "-");
    let slug = base;
    for (let suffix = 1; used.has(slug); suffix++) {
      slug = `${base}-${suffix}`;
    }
    used.add(slug);
    return slug;
  });
  // Markdown uses heading slugs; Wiki links may instead name the full heading.
  return (
    headings.find((_heading, index) => slugs[index] === target) ??
    headings.find((heading) => heading.textContent?.trim().toLowerCase() === target)
  );
}

class PlatformClawVaultReader extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) refreshing = false;
  @property({ attribute: false }) methods: readonly string[] = [];
  @property() agentId: string | null = null;
  @property({ attribute: false }) selection!: VaultReaderSelection;
  @state() private document: KnowledgeVaultDocument | null = null;
  @state() private vault: KnowledgeVault | KnowledgeVaultCatalogEntry | null = null;
  @state() private editing = false;
  @state() private deleting = false;
  @state() private busy = false;
  @state() private error = "";
  @state() private linkNotice: "unresolvedNotice" | "headingUnavailable" | null = null;
  private request = 0;
  private requestedDocumentId = "";
  private requestedHeading = "";

  protected override updated(changed: PropertyValues) {
    const identityChanged = ["client", "agentId", "selection"].some((key) => changed.has(key));
    if (identityChanged) {
      this.request++;
      this.document = null;
      this.requestedDocumentId = this.selection.documentId;
      this.requestedHeading = "";
      this.linkNotice = null;
      this.vault = null;
      this.editing = this.deleting = false;
      this.error = "";
      this.vault = this.selection.vault ?? null;
      this.document = this.selection.document ?? null;
    }
    if (identityChanged || changed.has("connected")) {
      this.request++;
      this.busy = false;
      if (this.client && this.connected && (!this.document || !this.vault)) {
        void this.load(
          this.requestedDocumentId || this.selection.documentId,
          this.requestedHeading,
        );
      }
    }
  }
  override disconnectedCallback() {
    this.request++;
    super.disconnectedCallback();
  }
  private close() {
    // Closing owns invalidation, including linked reads and pending ACL loads.
    this.request++;
    this.dispatchEvent(new CustomEvent("reader-close", { bubbles: true }));
  }
  private async openDocument(documentId: string, heading = "") {
    if (documentId !== this.document?.id) {
      await this.load(documentId, heading);
      return;
    }
    const request = this.request;
    this.linkNotice = null;
    await this.updateComplete;
    if (request === this.request && this.connected && this.isConnected) {
      this.scrollToHeading(heading);
    }
  }
  private scrollToHeading(fragment: string) {
    const body = this.querySelector<HTMLElement>(".wiki-hub__preview-body");
    const article = this.querySelector(".wiki-document__reader");
    if (!body || !article) {
      return;
    }
    if (!fragment) {
      body.scrollTop = 0;
      return;
    }
    const heading = findVaultHeading(article, fragment);
    if (!heading) {
      this.linkNotice = "headingUnavailable";
      body.scrollTop = 0;
      return;
    }
    // Scroll only the modal body; native hash navigation can move the underlying app.
    body.scrollTop += heading.getBoundingClientRect().top - body.getBoundingClientRect().top;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  private async showUnresolvedLink() {
    const request = this.request;
    this.linkNotice = "unresolvedNotice";
    await this.updateComplete;
    if (request === this.request) {
      const body = this.querySelector<HTMLElement>(".wiki-hub__preview-body");
      if (body) {
        body.scrollTop = 0;
      }
    }
  }
  private async load(documentId: string, heading = "") {
    if (!this.client || !this.connected) {
      return;
    }
    const request = ++this.request;
    this.requestedDocumentId = documentId;
    this.requestedHeading = heading;
    this.busy = true;
    this.error = "";
    this.linkNotice = null;
    try {
      const [document, snapshot] = await Promise.all([
        this.client!.request<KnowledgeVaultDocument>("platformclaw.vault.document.get", {
          vaultId: this.selection.vaultId,
          documentId,
        }),
        this.vault
          ? Promise.resolve(null)
          : this.client!.request<KnowledgeVaultSnapshot>("platformclaw.vault.snapshot", {
              vaultId: this.selection.vaultId,
            }),
      ]);
      if (request !== this.request) {
        return;
      }
      this.vault = this.vault ?? snapshot?.selected?.vault ?? null;
      if (!this.vault || this.vault.id !== this.selection.vaultId) {
        throw new Error(t("unavailable"));
      }
      this.document = document;
    } catch (error) {
      if (request === this.request) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (request === this.request) {
        this.busy = false;
        await this.updateComplete;
        if (request === this.request && this.document?.id === documentId && !this.error) {
          this.scrollToHeading(heading);
        }
      }
    }
  }
  private async deleteDocument() {
    if (!this.document || !this.client || !this.connected || this.busy) {
      return;
    }
    const request = ++this.request;
    this.busy = true;
    this.error = "";
    try {
      await this.client.request("platformclaw.vault.document.delete", {
        vaultId: this.document.vaultId,
        documentId: this.document.id,
        expectedRevision: this.document.revision,
      });
      if (request !== this.request) {
        return;
      }
      this.dispatchEvent(
        new CustomEvent("reader-deleted", {
          bubbles: true,
          detail: { vaultId: this.document.vaultId, documentId: this.document.id },
        }),
      );
      this.close();
    } catch (error) {
      if (request === this.request) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (request === this.request) {
        this.busy = false;
      }
    }
  }
  override render() {
    if (this.deleting && this.document) {
      return renderVaultDialog({
        title: t("deleteDocument"),
        busy: this.busy,
        error: this.error,
        onClose: () => {
          this.deleting = false;
          this.error = "";
        },
        content: html`<p><strong>${this.document.title}</strong></p>
          <p>${t("deleteDocumentHint")}</p>
          <div class="vaults__actions">
            <button
              class="btn danger"
              ?disabled=${this.busy || !this.connected}
              @click=${() => void this.deleteDocument()}
            >
              ${t("deleteDocument")}</button
            ><button
              class="btn"
              ?disabled=${this.busy}
              @click=${() => {
                this.deleting = false;
                this.error = "";
              }}
            >
              ${t("cancel")}
            </button>
          </div>`,
      });
    }
    if (this.editing && this.document && this.vault) {
      return html`<platformclaw-vault-author
        .client=${this.client}
        .connected=${this.connected}
        .agentId=${this.agentId}
        .methods=${this.methods}
        .vault=${this.vault}
        .document=${this.document}
        @author-close=${() => (this.editing = false)}
        @author-saved=${(event: CustomEvent<VaultAuthorSaved>) => {
          event.stopPropagation();
          this.document = event.detail.document;
          this.editing = false;
          // Parent refreshes lists only. It must never reopen this reader after close.
          this.dispatchEvent(
            new CustomEvent("reader-saved", { detail: event.detail, bubbles: true }),
          );
        }}
      ></platformclaw-vault-author>`;
    }
    if (!this.document || !this.vault || this.error) {
      return renderVaultDialog({
        title: t("documentDetails"),
        error: this.error,
        busy: false,
        onClose: () => this.close(),
        content: this.busy
          ? html`<p role="status">${t("loading")}</p>`
          : html`<button
              class="btn"
              ?disabled=${!this.connected}
              @click=${() => void this.load(this.requestedDocumentId, this.requestedHeading)}
            >
              ${platformClawT("memoryPage.memories.retry")}
            </button>`,
      });
    }
    return renderVaultDocument({
      document: this.document,
      vaultName: this.vault.name,
      vaultType: this.vault.type,
      onDelete:
        this.vault.canEdit && this.methods.includes("platformclaw.vault.document.delete")
          ? () => {
              this.deleting = true;
            }
          : undefined,
      onPublish:
        this.vault.type === "personal" && this.methods.includes("platformclaw.vault.publish")
          ? () =>
              this.dispatchEvent(
                new CustomEvent("reader-publish", {
                  bubbles: true,
                  detail: this.document!.logicalPath,
                }),
              )
          : undefined,
      canEdit:
        this.vault.canEdit &&
        this.document.editMode !== null &&
        this.methods.includes("platformclaw.vault.document.save") &&
        this.methods.includes("platformclaw.vault.document.preview"),
      busy: this.busy || this.refreshing || !this.connected,
      linkNotice: this.linkNotice ? t(this.linkNotice) : undefined,
      onOpen: (id, heading) => void this.openDocument(id, heading),
      onUnresolvedLink: () => void this.showUnresolvedLink(),
      onEdit: () => (this.editing = true),
      onDownload: () => {
        const document = this.document!;
        const url = URL.createObjectURL(
          new Blob([document.sourceContent ?? document.content], {
            type: "text/markdown;charset=utf-8",
          }),
        );
        const anchor = globalThis.document.createElement("a");
        anchor.href = url;
        anchor.download = document.logicalPath.split("/").at(-1)!;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      },
      onClose: () => this.close(),
    });
  }
}
if (!customElements.get("platformclaw-vault-reader")) {
  customElements.define("platformclaw-vault-reader", PlatformClawVaultReader);
}
