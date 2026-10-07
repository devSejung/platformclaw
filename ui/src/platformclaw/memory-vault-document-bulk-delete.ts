import { formatErrorMessage } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  KnowledgeVault,
  KnowledgeVaultDocument,
  KnowledgeVaultDocumentSummary,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT } from "./i18n.ts";
import { renderVaultDialog } from "./memory-vault-catalog.ts";

const RPC = "platformclaw.vault.document.";
const REQUEST_TIMEOUT_MS = 30_000;
const t = (key: string, params?: Record<string, string>) =>
  platformClawT(`platformClaw.vault.${key}`, params);

type VaultDocumentBulkDeleteItem = {
  documentId: string;
  title: string;
  logicalPath: string;
} & (
  | { status: "reading" | "not-attempted" }
  | { status: "ready"; revision: number | string }
  | { status: "excluded"; reason: "edit" | "generated" | "invalid" }
  | { status: "read-failed" | "failed" | "unconfirmed"; error: string }
  | { status: "deleted"; indexesRefreshed?: boolean }
);

type BatchIdentity = {
  client: GatewayBrowserClient;
  agentId: string | null;
  vaultId: string;
};
export type VaultDocumentBulkDeleteResult = BatchIdentity & {
  items: VaultDocumentBulkDeleteItem[];
};
export type VaultDocumentsBulkDeleted = BatchIdentity & { documentIds: string[] };

class PlatformClawVaultDocumentBulkDelete extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property() agentId: string | null = null;
  @property({ attribute: false }) vault: KnowledgeVault | null = null;
  @property({ attribute: false }) documents: readonly KnowledgeVaultDocumentSummary[] = [];
  @state() private items: VaultDocumentBulkDeleteItem[] = [];
  @state() private phase: "preparing" | "confirm" | "running" | "complete" = "preparing";
  @state() private pendingId: string | null = null;
  @state() private stopReason = "";
  private owner: (BatchIdentity & { vaultType: KnowledgeVault["type"] }) | null = null;
  private initialized = false;
  private readController: AbortController | null = null;

  protected override updated() {
    if (!this.initialized) {
      this.initialized = true;
      if (!this.client || !this.vault) {
        this.stop("documentBulkDeleteSessionChanged");
        return;
      }
      this.owner = {
        client: this.client,
        agentId: this.agentId,
        vaultId: this.vault.id,
        vaultType: this.vault.type,
      };
      // The dialog owns a frozen selection. Later filters, refreshes, and prop changes
      // cannot add documents to the confirmation or replace their identities.
      const unique = new Map(this.documents.map((document) => [document.id, document]));
      this.items = [...unique.values()].map((document): VaultDocumentBulkDeleteItem => {
        const identity = {
          documentId: document.id,
          title: document.title,
          logicalPath: document.logicalPath,
        };
        if (document.vaultId !== this.owner!.vaultId) {
          return Object.assign(identity, {
            status: "excluded" as const,
            reason: "invalid" as const,
          });
        }
        if (!this.vault!.canEdit) {
          return Object.assign(identity, { status: "excluded" as const, reason: "edit" as const });
        }
        return Object.assign(identity, { status: "reading" as const });
      });
      void this.prepare();
    } else if (!this.sameIdentity || !this.connected) {
      this.stop("documentBulkDeleteSessionChanged");
    } else if (!this.vault?.canEdit) {
      this.stop("documentBulkDeleteEditRequired");
    }
  }

  override disconnectedCallback() {
    this.stop("documentBulkDeleteStopped");
    super.disconnectedCallback();
  }

  private get sameIdentity() {
    return (
      this.owner?.client === this.client &&
      this.owner?.agentId === this.agentId &&
      this.owner?.vaultId === this.vault?.id &&
      this.owner?.vaultType === this.vault?.type
    );
  }

  private get active() {
    return this.sameIdentity && this.connected && this.isConnected && !this.stopReason;
  }

  private stop(reason: string) {
    this.stopReason ||= reason;
    this.readController?.abort();
    if (this.phase !== "running") {
      this.phase = "complete";
      this.markUnattempted();
    }
  }

  private markUnattempted() {
    if (!this.items.some((item) => item.status === "ready" || item.status === "reading")) {
      return;
    }
    this.items = this.items.map((item) =>
      item.status === "ready" || item.status === "reading"
        ? { ...item, status: "not-attempted" }
        : item,
    );
  }

  private replaceItem(item: VaultDocumentBulkDeleteItem) {
    this.items = this.items.map((entry) => (entry.documentId === item.documentId ? item : entry));
  }

  private async prepare() {
    if (!this.owner || !this.active) {
      this.stop("documentBulkDeleteSessionChanged");
      return;
    }
    const { client, vaultId, vaultType } = this.owner;
    const controller = new AbortController();
    this.readController = controller;
    for (const item of this.items.filter((entry) => entry.status === "reading")) {
      if (!this.active || !this.vault?.canEdit) {
        break;
      }
      try {
        // Graph/catalog revisions and snippets are not sufficient for destructive review.
        const document = await client.request<KnowledgeVaultDocument>(
          `${RPC}get`,
          { vaultId, documentId: item.documentId },
          { timeoutMs: REQUEST_TIMEOUT_MS, signal: controller.signal },
        );
        if (!this.active) {
          return;
        }
        const validRevision =
          vaultType === "personal"
            ? typeof document?.revision === "string" && /^[a-f0-9]{64}$/u.test(document.revision)
            : Number.isSafeInteger(document?.revision) && Number(document.revision) > 0;
        if (
          document?.id !== item.documentId ||
          document.vaultId !== vaultId ||
          typeof document.title !== "string" ||
          typeof document.content !== "string" ||
          !validRevision ||
          (vaultType === "personal" && typeof document.sourceContent !== "string")
        ) {
          this.replaceItem({ ...item, status: "excluded", reason: "invalid" });
          continue;
        }
        this.replaceItem({
          ...item,
          title: document.title,
          logicalPath: document.logicalPath,
          ...(document.canDelete === false
            ? { status: "excluded", reason: "generated" }
            : { status: "ready", revision: document.revision }),
        });
      } catch (error) {
        if (!this.active) {
          return;
        }
        this.replaceItem({
          ...item,
          status: "read-failed",
          error: formatErrorMessage(error, { redact: redactToolDetail }),
        });
      }
    }
    this.readController = null;
    if (this.active) {
      this.phase = "confirm";
    }
  }

  private close() {
    if (this.phase === "running") {
      return false;
    }
    this.stop("documentBulkDeleteStopped");
    this.dispatchEvent(new CustomEvent("document-bulk-close", { bubbles: true }));
    return true;
  }

  private async confirm() {
    if (this.phase !== "confirm" || !this.owner || !this.active || !this.vault?.canEdit) {
      return;
    }
    const targets = this.items.filter((item) => item.status === "ready");
    if (!targets.length) {
      return;
    }
    const { client, agentId, vaultId } = this.owner;
    this.phase = "running";
    this.dispatchEvent(new CustomEvent("document-bulk-busy", { bubbles: true, detail: true }));
    for (const target of targets) {
      if (!this.active || !this.vault?.canEdit) {
        this.stop("documentBulkDeleteSessionChanged");
        break;
      }
      this.pendingId = target.documentId;
      let outcome: VaultDocumentBulkDeleteItem;
      try {
        const response = await client.request(
          `${RPC}delete`,
          { vaultId, documentId: target.documentId, expectedRevision: target.revision },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        outcome =
          isRecord(response) &&
          response.deleted === true &&
          response.documentId === target.documentId
            ? {
                ...target,
                status: "deleted",
                ...(typeof response.indexesRefreshed === "boolean"
                  ? { indexesRefreshed: response.indexesRefreshed }
                  : {}),
              }
            : { ...target, status: "unconfirmed", error: t("documentBulkDeleteUnconfirmedHint") };
      } catch (error) {
        const rejected =
          error instanceof GatewayRequestError &&
          ((isRecord(error.details) &&
            error.details.requestDisposition === "rejected-before-dispatch") ||
            (this.owner.vaultType === "shared" &&
              ["FORBIDDEN", "INVALID_REQUEST", "UNAUTHENTICATED"].includes(error.gatewayCode)));
        // Personal mutations cross another Gateway: even FORBIDDEN can describe
        // a malformed response after deletion committed, not a permission rejection.
        // A lost mutation reply may already have committed. Do not retry or advance.
        outcome = {
          ...target,
          status: rejected ? "failed" : "unconfirmed",
          error: formatErrorMessage(error, { redact: redactToolDetail }),
        };
      }
      this.replaceItem(outcome);
      this.pendingId = null;
      if (outcome.status !== "deleted") {
        this.stop("documentBulkDeleteFailureStopped");
        break;
      }
      if (this.sameIdentity && this.isConnected) {
        this.dispatchEvent(
          new CustomEvent<VaultDocumentsBulkDeleted>("document-bulk-deleted", {
            bubbles: true,
            detail: { client, agentId, vaultId, documentIds: [target.documentId] },
          }),
        );
      }
    }
    this.markUnattempted();
    this.phase = "complete";
    this.dispatchEvent(new CustomEvent("document-bulk-busy", { bubbles: true, detail: false }));
    this.dispatchEvent(
      new CustomEvent<VaultDocumentBulkDeleteResult>("document-bulk-delete-result", {
        bubbles: true,
        detail: { client, agentId, vaultId, items: this.items.map((item) => ({ ...item })) },
      }),
    );
  }

  private itemStatus(item: VaultDocumentBulkDeleteItem) {
    if (item.documentId === this.pendingId) {
      return t("documentBulkDeletePending");
    }
    if (item.status === "excluded") {
      return t(
        item.reason === "edit"
          ? "documentBulkDeleteEditRequired"
          : item.reason === "generated"
            ? "documentBulkDeleteGeneratedExcluded"
            : "documentBulkDeleteInvalidDocument",
      );
    }
    const labels = {
      reading: "documentBulkDeletePreparing",
      ready: "documentBulkDeleteWillDelete",
      "read-failed": "documentBulkDeleteReadFailed",
      "not-attempted": "documentBulkDeleteNotAttempted",
      deleted: "documentBulkDeleteDeleted",
      failed: "documentBulkDeleteFailed",
      unconfirmed: "documentBulkDeleteUnconfirmed",
    } as const;
    return t(labels[item.status]);
  }

  override render() {
    const count = this.items.filter((item) => item.status === "ready").length;
    return renderVaultDialog({
      title: t("documentBulkDeleteTitle"),
      busy: this.phase === "running",
      error: "",
      onClose: () => this.close(),
      content: html`<section class="vaults__form">
        ${this.sameIdentity
          ? html`<p><strong>${this.vault?.name}</strong></p>
              ${this.phase === "preparing"
                ? html`<p role="status">${t("documentBulkDeletePreparing")}</p>`
                : this.phase === "confirm"
                  ? html`<p>${t("documentBulkDeleteHint", { count: String(count) })}</p>`
                  : nothing}
              ${this.owner?.vaultType === "personal"
                ? html`<p class="vaults__hint">${t("documentBulkDeletePersonalHint")}</p>`
                : nothing}
              <ul aria-live="polite">
                ${this.items.map(
                  (item) => html`<li
                    data-document-delete-result=${item.documentId}
                    data-delete-status=${item.status}
                  >
                    <strong>${item.title}</strong> · ${this.itemStatus(item)}
                    <p class="vaults__hint">${item.logicalPath}</p>
                    ${"error" in item ? html`<p class="vaults__hint">${item.error}</p>` : nothing}
                    ${item.status === "deleted" && item.indexesRefreshed === false
                      ? html`<p class="callout warning" role="status">
                          ${t("documentBulkDeleteIndexWarning")}
                        </p>`
                      : nothing}
                  </li>`,
                )}
              </ul>`
          : nothing}
        ${this.stopReason ? html`<p role="status">${t(this.stopReason)}</p>` : nothing}
        ${this.sameIdentity && this.items.some((item) => item.status === "unconfirmed")
          ? html`<p role="alert">${t("documentBulkDeleteUnconfirmedHint")}</p>`
          : nothing}
        ${this.phase === "confirm" && !count
          ? html`<p role="status">${t("documentBulkDeleteNoEligible")}</p>`
          : nothing}
        <div class="vaults__actions">
          ${this.phase === "confirm"
            ? html`<button
                  class="btn danger"
                  ?disabled=${!this.active || !this.vault?.canEdit || !count}
                  @click=${() => void this.confirm()}
                >
                  ${t("documentBulkDeleteConfirm", { count: String(count) })}
                </button>
                <button class="btn" autofocus @click=${() => this.close()}>${t("cancel")}</button>`
            : this.phase === "running"
              ? html`<button
                  class="btn"
                  ?disabled=${Boolean(this.stopReason)}
                  @click=${() => this.stop("documentBulkDeleteStopped")}
                >
                  ${t("documentBulkDeleteStop")}
                </button>`
              : html`<button class="btn" @click=${() => this.close()}>
                  ${t(this.phase === "preparing" ? "cancel" : "closeDialog")}
                </button>`}
        </div>
      </section>`,
    });
  }
}

if (!customElements.get("platformclaw-vault-document-bulk-delete")) {
  customElements.define(
    "platformclaw-vault-document-bulk-delete",
    PlatformClawVaultDocumentBulkDelete,
  );
}
