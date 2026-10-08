import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import {
  KNOWLEDGE_VAULT_LIMITS,
  type KnowledgeVault,
  type KnowledgeVaultCatalogEntry,
  type KnowledgeVaultDocument,
  type KnowledgeVaultDocumentPublishResult,
  type KnowledgeVaultDocumentSummary,
  type KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { formatBytes } from "../lib/agents/display.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { generateUUID } from "../lib/uuid.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT } from "./i18n.ts";
import { renderVaultDialog } from "./memory-vault-catalog.ts";
import "./memory-vault-upload.css";
import "./memory-vaults.css";

const RPC = "platformclaw.vault.";
const REQUEST_TIMEOUT_MS = 30_000;
const t = (key: string, params?: Record<string, string>) =>
  platformClawT(`platformClaw.vault.${key}`, params);
type PublishOutcome = KnowledgeVaultDocumentPublishResult["documents"][number];
type ReviewedSource = { sourceContent: string; expectedRevision: string; bytes: number };
type PublishEntry = { documentId: string; title: string; path: string } & (
  | { status: "loading" | "invalid"; message?: string }
  | (ReviewedSource &
      (
        | { status: "ready" | "publishing" | "uncertain" }
        | { status: "result"; outcome: PublishOutcome }
      ))
);
type ReadyEntry = PublishEntry & ReviewedSource;

export type VaultDocumentPublishSummary = {
  vaultId: string;
  targetVaultId: string;
  confirmedDocumentIds: string[];
  published: number;
  unchanged: number;
  failed: number;
  uncertain: number;
  pending: number;
};

function canPublish(entry: PublishEntry): entry is ReadyEntry {
  return (
    entry.status === "ready" ||
    entry.status === "uncertain" ||
    (entry.status === "result" &&
      entry.outcome.status === "failed" &&
      entry.outcome.error === "unavailable")
  );
}

class PlatformClawVaultDocumentBulkPublish extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ attribute: false }) methods: readonly string[] = [];
  @property() agentId: string | null = null;
  @property({ attribute: false }) vault: KnowledgeVault | KnowledgeVaultCatalogEntry | null = null;
  @property({ attribute: false }) documents: readonly KnowledgeVaultDocumentSummary[] = [];
  @state() private entries: PublishEntry[] = [];
  @state() private destinations: KnowledgeVaultCatalogEntry[] = [];
  @state() private targetVaultId = "";
  @state() private targetVaultName = "";
  @state() private phase: "idle" | "reading" | "publishing" = "idle";
  @state() private error = "";
  @state() private reviewed = false;
  @state() private previewId = "";
  @state() private attempted = false;
  @state() private stopping = false;
  @state() private confirmingLeave = false;
  private publishId = "";
  private operation = 0;
  private readController: AbortController | null = null;
  private reviewKey = "";
  private reviewClient: GatewayBrowserClient | null = null;
  private readonly preventPendingUnload = (event: BeforeUnloadEvent) => {
    if (this.phase === "publishing" || this.hasUnfinishedCopies) {
      event.preventDefault();
      event.returnValue = "";
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("beforeunload", this.preventPendingUnload);
  }
  override disconnectedCallback() {
    this.operation++;
    this.readController?.abort();
    window.removeEventListener("beforeunload", this.preventPendingUnload);
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues) {
    const contextChanged =
      this.reviewKey !== this.contextKey() || this.reviewClient !== this.client;
    if (contextChanged) {
      this.operation++;
      this.readController?.abort();
      this.reviewKey = this.contextKey();
      this.reviewClient = this.client;
      this.entries = [];
      this.destinations = [];
      this.targetVaultId = this.targetVaultName = this.publishId = this.error = this.previewId = "";
      this.reviewed = this.attempted = this.stopping = this.confirmingLeave = false;
      this.phase = "idle";
      if (this.available) {
        void this.prepare();
      }
    } else if (
      (changed.has("connected") || changed.has("methods")) &&
      !this.available &&
      this.phase !== "idle"
    ) {
      this.operation++;
      this.readController?.abort();
      const publishing = this.phase === "publishing";
      this.entries = this.entries.map((entry) =>
        entry.status === "publishing"
          ? { ...entry, status: "uncertain" }
          : entry.status === "loading"
            ? { ...entry, status: "invalid", message: t("sourceUnavailable") }
            : entry,
      );
      this.phase = "idle";
      this.error = t(publishing ? "bulkPublishInterrupted" : "sourceUnavailable");
      if (publishing) {
        this.report();
      }
    } else if (changed.has("connected") && this.available && !this.entries.length) {
      void this.prepare();
    }
    // Option removal/remounting can reset native selection after property bindings run.
    const destination = this.querySelector<HTMLSelectElement>("[data-publish-destination]");
    if (destination) {
      destination.value = this.targetVaultId;
    }
    if (changed.has("phase")) {
      this.dispatchEvent(
        new CustomEvent("document-publish-busy", {
          bubbles: true,
          detail: this.phase !== "idle",
        }),
      );
    }
  }
  private contextKey() {
    return JSON.stringify([
      this.agentId,
      this.vault?.id,
      this.vault?.type,
      this.vault?.canRead,
      this.vault?.canEdit,
      this.documents.map((document) => [document.vaultId, document.id]),
    ]);
  }
  private current(operation: number) {
    return (
      operation === this.operation &&
      this.reviewKey === this.contextKey() &&
      this.reviewClient === this.client &&
      this.available &&
      this.isConnected
    );
  }
  private get available() {
    return Boolean(
      this.client &&
      this.connected &&
      this.methods.includes(`${RPC}document.publish`) &&
      this.methods.includes(`${RPC}document.get`),
    );
  }
  private selectionIssue() {
    if (!this.documents.length || this.documents.length > KNOWLEDGE_VAULT_LIMITS.files) {
      return t("bulkPublishSelectionLimit", { count: String(KNOWLEDGE_VAULT_LIMITS.files) });
    }
    if (
      !this.agentId ||
      this.vault?.id !== `personal:${this.agentId}` ||
      this.vault.type !== "personal" ||
      !this.vault.canRead ||
      !this.vault.canEdit ||
      this.documents.some((document) => document.vaultId !== this.vault!.id) ||
      new Set(this.documents.map((document) => document.id)).size !== this.documents.length
    ) {
      return t("bulkPublishInvalidSelection");
    }
    return "";
  }
  private async prepare() {
    if (!this.available || this.phase !== "idle" || this.attempted) {
      return;
    }
    this.error = this.selectionIssue();
    if (this.error) {
      return;
    }
    const operation = ++this.operation;
    const controller = new AbortController();
    this.readController = controller;
    this.phase = "reading";
    this.reviewed = false;
    this.entries = this.documents.map((document) => ({
      documentId: document.id,
      title: document.title,
      path: document.logicalPath,
      status: "loading",
    }));
    try {
      try {
        this.publishId = generateUUID();
      } catch {
        throw new Error(t("bulkPublishCryptoUnavailable"));
      }
      const snapshot = await this.client!.request<KnowledgeVaultSnapshot>(
        `${RPC}snapshot`,
        {},
        { timeoutMs: REQUEST_TIMEOUT_MS, signal: controller.signal },
      );
      if (!this.current(operation)) {
        return;
      }
      this.destinations = snapshot.vaults.filter(
        (vault) => vault.type === "shared" && vault.canRead && vault.canEdit,
      );
      this.targetVaultId = this.destinations.length === 1 ? this.destinations[0]!.id : "";
      let bytes = 0;
      for (const selected of this.documents) {
        let entry: PublishEntry;
        try {
          const document = await this.client!.request<KnowledgeVaultDocument>(
            `${RPC}document.get`,
            {
              vaultId: this.vault!.id,
              documentId: selected.id,
            },
            { timeoutMs: REQUEST_TIMEOUT_MS, signal: controller.signal },
          );
          if (!this.current(operation)) {
            return;
          }
          if (
            document.id !== selected.id ||
            document.logicalPath !== selected.id ||
            document.vaultId !== this.vault!.id ||
            typeof document.sourceContent !== "string" ||
            typeof document.revision !== "string" ||
            !/^[a-f0-9]{64}$/u.test(document.revision)
          ) {
            throw new Error(t("sourceUnavailable"));
          }
          const size = new TextEncoder().encode(document.sourceContent).length;
          if (size > KNOWLEDGE_VAULT_LIMITS.documentBytes) {
            throw new Error(t("importDocumentLimit"));
          }
          bytes += size;
          if (bytes > KNOWLEDGE_VAULT_LIMITS.expandedBytes) {
            throw new Error(
              t("bulkPublishTotalLimit", {
                size: formatBytes(KNOWLEDGE_VAULT_LIMITS.expandedBytes),
              }),
            );
          }
          // document.get owns the complete source/revision pair. Do not copy an
          // excerpt, editable Notes, or linked pages, and do not re-read on retry.
          entry = {
            documentId: document.id,
            title: document.title,
            path: document.logicalPath,
            sourceContent: document.sourceContent,
            expectedRevision: document.revision,
            bytes: size,
            status: "ready",
          };
          this.previewId ||= document.id;
        } catch (error) {
          if (!this.current(operation)) {
            return;
          }
          entry = {
            documentId: selected.id,
            title: selected.title,
            path: selected.logicalPath,
            status: "invalid",
            message: formatErrorMessage(error, { redact: redactToolDetail }),
          };
        }
        this.entries = this.entries.map((current) =>
          current.documentId === selected.id ? entry : current,
        );
        if (bytes > KNOWLEDGE_VAULT_LIMITS.expandedBytes) {
          this.entries = this.entries.map((current) =>
            current.status === "loading"
              ? {
                  ...current,
                  status: "invalid",
                  message: entry.status === "invalid" ? entry.message : t("sourceUnavailable"),
                }
              : current,
          );
          break;
        }
      }
    } catch (error) {
      if (this.current(operation)) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
        this.entries = this.entries.map((entry) =>
          entry.status === "loading"
            ? { ...entry, status: "invalid", message: t("sourceUnavailable") }
            : entry,
        );
      }
    } finally {
      if (this.current(operation)) {
        this.phase = "idle";
      }
    }
  }
  private get pending() {
    return this.entries.filter(canPublish);
  }
  private get hasUnfinishedCopies() {
    return this.attempted && this.pending.length > 0;
  }
  private get ready() {
    return (
      this.available &&
      this.phase === "idle" &&
      !this.selectionIssue() &&
      this.reviewed &&
      this.pending.length > 0 &&
      !this.entries.some((entry) => entry.status === "invalid" || entry.status === "loading") &&
      Boolean(this.targetVaultId) &&
      (this.attempted || this.destinations.some((vault) => vault.id === this.targetVaultId))
    );
  }
  private summary(): VaultDocumentPublishSummary {
    const outcomes = this.entries.flatMap((entry) =>
      entry.status === "result" ? [entry.outcome] : [],
    );
    return {
      vaultId: this.vault?.id ?? "",
      targetVaultId: this.targetVaultId,
      confirmedDocumentIds: outcomes.flatMap((outcome) =>
        outcome.status === "failed" ? [] : [outcome.sourceDocumentId],
      ),
      published: outcomes.filter((outcome) => outcome.status === "published").length,
      unchanged: outcomes.filter((outcome) => outcome.status === "unchanged").length,
      failed:
        outcomes.filter((outcome) => outcome.status === "failed").length +
        this.entries.filter((entry) => entry.status === "invalid").length,
      uncertain: this.entries.filter((entry) => entry.status === "uncertain").length,
      pending: this.entries.filter(
        (entry) => entry.status === "ready" || entry.status === "publishing",
      ).length,
    };
  }
  private report() {
    this.dispatchEvent(
      new CustomEvent<VaultDocumentPublishSummary>("document-publish-complete", {
        bubbles: true,
        detail: this.summary(),
      }),
    );
  }
  private async publish() {
    if (!this.ready || !this.current(this.operation)) {
      return;
    }
    const operation = ++this.operation;
    const targetVaultId = this.targetVaultId;
    if (!this.attempted) {
      this.targetVaultName =
        this.destinations.find((vault) => vault.id === targetVaultId)?.name ?? targetVaultId;
    }
    const publishId = this.publishId;
    const pending = this.pending;
    this.phase = "publishing";
    this.error = "";
    this.stopping = false;
    try {
      // Refresh destination access before each explicitly requested attempt.
      const snapshot = await this.client!.request<KnowledgeVaultSnapshot>(
        `${RPC}snapshot`,
        {},
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (!this.current(operation)) {
        return;
      }
      this.destinations = snapshot.vaults.filter(
        (vault) => vault.type === "shared" && vault.canRead && vault.canEdit,
      );
      if (!this.destinations.some((vault) => vault.id === targetVaultId)) {
        throw new Error(t("bulkPublishDestinationUnavailable"));
      }
      while (pending.length && !this.stopping) {
        let bytes = 0;
        const batch: ReadyEntry[] = [];
        while (
          pending.length &&
          batch.length < Math.min(20, KNOWLEDGE_VAULT_LIMITS.publishDocuments) &&
          bytes + pending[0]!.bytes <= KNOWLEDGE_VAULT_LIMITS.publishBytes
        ) {
          const entry = pending.shift()!;
          bytes += entry.bytes;
          batch.push(entry);
        }
        const ids = new Set(batch.map((entry) => entry.documentId));
        this.entries = this.entries.map((entry) =>
          canPublish(entry) && ids.has(entry.documentId)
            ? { ...entry, status: "publishing" }
            : entry,
        );
        this.attempted = true;
        const result = await this.client!.request<KnowledgeVaultDocumentPublishResult>(
          `${RPC}document.publish`,
          {
            vaultId: this.vault!.id,
            targetVaultId,
            publishId,
            documents: batch.map(({ documentId, expectedRevision }) => ({
              documentId,
              expectedRevision,
            })),
          },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        if (!this.current(operation)) {
          return;
        }
        const outcomes = new Map(
          result.documents.map((outcome) => [outcome.sourceDocumentId, outcome]),
        );
        if (
          result.publishId !== publishId ||
          result.targetVaultId !== targetVaultId ||
          result.rootPath !== `imports/${publishId}` ||
          result.documents.length !== batch.length ||
          outcomes.size !== batch.length ||
          batch.some((entry) => {
            const outcome = outcomes.get(entry.documentId);
            return (
              !outcome ||
              (outcome.status === "failed"
                ? !["conflict", "unavailable", "invalid", "forbidden"].includes(outcome.error)
                : !["published", "unchanged"].includes(outcome.status) ||
                  !outcome.documentId ||
                  outcome.logicalPath !== `${result.rootPath}/${entry.documentId}` ||
                  !Number.isInteger(outcome.revision) ||
                  outcome.revision < 1 ||
                  !["ready", "pending", "failed"].includes(outcome.compile?.status))
            );
          })
        ) {
          throw new Error(t("bulkPublishUnconfirmed"));
        }
        this.entries = this.entries.map((entry) =>
          entry.status === "publishing"
            ? { ...entry, status: "result", outcome: outcomes.get(entry.documentId)! }
            : entry,
        );
      }
    } catch (error) {
      if (this.current(operation)) {
        const uncertain = this.entries.some((entry) => entry.status === "publishing");
        this.entries = this.entries.map((entry) =>
          entry.status === "publishing" ? { ...entry, status: "uncertain" } : entry,
        );
        const message = formatErrorMessage(error, { redact: redactToolDetail });
        this.error = uncertain ? `${t("bulkPublishInterrupted")} ${message}` : message;
      }
    } finally {
      if (this.current(operation)) {
        this.phase = "idle";
        this.report();
      }
    }
  }
  private close() {
    if (this.phase === "publishing") {
      this.stopping = true;
      return false;
    }
    if (this.confirmingLeave) {
      this.confirmingLeave = false;
      return false;
    }
    if (this.hasUnfinishedCopies) {
      this.confirmingLeave = true;
      return false;
    }
    this.finishClose();
    return true;
  }
  private finishClose() {
    this.operation++;
    this.readController?.abort();
    this.dispatchEvent(new CustomEvent("document-publish-close", { bubbles: true }));
  }
  private entryStatus(entry: PublishEntry) {
    if (entry.status === "invalid") {
      return entry.message;
    }
    if (entry.status === "result" && entry.outcome.status === "failed") {
      return t(
        {
          conflict: "bulkPublishConflict",
          forbidden: "bulkPublishForbidden",
          invalid: "bulkPublishInvalid",
          unavailable: "bulkPublishFailed",
        }[entry.outcome.error],
      );
    }
    return t(
      `bulkPublishStatus.${entry.status === "result" ? entry.outcome.status : entry.status}`,
    );
  }
  override render() {
    const summary = this.summary();
    const counts = Object.fromEntries(
      Object.entries(summary).map(([key, value]) => [key, String(value)]),
    );
    const loaded = this.entries.filter((entry) => entry.status !== "loading").length;
    const preview = this.entries.find((entry) => entry.documentId === this.previewId);
    const busy = this.phase !== "idle";
    const completed = summary.published + summary.unchanged + summary.failed;
    return renderVaultDialog({
      title: t("bulkPublishTitle"),
      busy: this.phase === "publishing",
      error: this.error,
      onClose: () => this.close(),
      content: this.confirmingLeave
        ? html` <p>${t("bulkPublishLeaveWarning")}</p>
            <div class="vaults__actions">
              <button class="btn primary" @click=${() => (this.confirmingLeave = false)}>
                ${t("keepEditing")}
              </button>
              <button class="btn" @click=${() => this.finishClose()}>
                ${t("bulkPublishLeave")}
              </button>
            </div>`
        : html`<section class="vaults__batch" data-document-bulk-publish>
            <p>${t("bulkPublishHint")}</p>
            ${!this.available ? html`<p role="status">${t("unavailable")}</p>` : nothing}
            <label class="vaults__select"
              >${t("bulkPublishDestination")}
              <select
                class="settings-select"
                data-publish-destination
                .value=${this.targetVaultId}
                ?disabled=${busy || this.attempted || !this.available}
                @change=${(event: Event) => {
                  this.targetVaultId = (event.currentTarget as HTMLSelectElement).value;
                  this.reviewed = false;
                }}
              >
                <option value="">${t("choose")}</option>
                ${this.attempted &&
                !this.destinations.some((vault) => vault.id === this.targetVaultId)
                  ? html`<option value=${this.targetVaultId}>${this.targetVaultName}</option>`
                  : nothing}
                ${this.destinations.map(
                  (vault) => html`<option value=${vault.id}>${vault.name}</option>`,
                )}
              </select>
            </label>
            <p class="vaults__hint">${t("bulkPublishDestinationHint")}</p>
            ${!this.destinations.length && !busy
              ? html`<p role="status">${t("noEditableVault")}</p>`
              : nothing}
            ${this.targetVaultId && this.publishId
              ? html`<p class="vaults__hint">
                  ${this.destinations.find((vault) => vault.id === this.targetVaultId)?.name ??
                  this.targetVaultId}
                  · imports/${this.publishId}/
                </p>`
              : nothing}
            <p role="status">${t("bulkPublishCounts", counts)}</p>
            <ul class="vaults__batch-list">
              ${this.entries.map(
                (entry) => html`<li
                  data-publish-status=${entry.status === "result"
                    ? entry.outcome.status
                    : entry.status}
                >
                  <div class="vaults__batch-file">
                    <button
                      class="vaults__batch-name"
                      ?disabled=${!("sourceContent" in entry)}
                      @click=${() => (this.previewId = entry.documentId)}
                    >
                      ${entry.title}
                    </button>
                    <span class="vaults__hint">${entry.path}</span>
                    <span role="status">${this.entryStatus(entry)}</span>
                    ${entry.status === "result" && entry.outcome.status !== "failed"
                      ? html`<span class="vaults__hint">${entry.outcome.logicalPath}</span>${entry
                            .outcome.compile.status !== "ready"
                            ? html`<span role="status">${t("bulkPublishIndexPending")}</span>`
                            : nothing}`
                      : nothing}
                  </div>
                </li>`,
              )}
            </ul>
            ${preview && "sourceContent" in preview
              ? html`<details class="vaults__batch-preview" open>
                  <summary>${t("importSourcePreview")}: ${preview.title}</summary>
                  <p class="vaults__hint">${preview.path} · ${preview.expectedRevision}</p>
                  <pre class="vaults__source">${preview.sourceContent}</pre>
                </details>`
              : nothing}
            ${this.phase === "reading"
              ? html`<p role="status">
                  ${t("bulkPublishReading", {
                    completed: String(loaded),
                    total: String(this.entries.length),
                  })}
                </p>`
              : nothing}
            ${this.phase === "publishing"
              ? html`<div class="vaults__batch-progress" role="status">
                  <span
                    >${t(this.stopping ? "bulkPublishStopping" : "bulkPublishProgress", {
                      completed: String(completed),
                      total: String(this.entries.length),
                    })}</span
                  >
                  <progress
                    value=${completed}
                    max=${this.entries.length || 1}
                    aria-label=${t("bulkPublishTitle")}
                  ></progress>
                </div>`
              : nothing}
            ${this.stopping && !busy && !this.error
              ? html`<p role="status">${t("bulkPublishCancelled")}</p>`
              : nothing}
            ${!this.attempted
              ? html`<label
                  ><input
                    type="checkbox"
                    data-publish-reviewed
                    .checked=${this.reviewed}
                    ?disabled=${busy ||
                    !this.available ||
                    !this.targetVaultId ||
                    this.entries.some((entry) => entry.status !== "ready")}
                    @change=${(event: Event) =>
                      (this.reviewed = (event.currentTarget as HTMLInputElement).checked)}
                  />${t("bulkPublishReview")}</label
                >`
              : nothing}
            <p class="vaults__hint">${t("bulkPublishRetryHint")}</p>
            <div class="vaults__actions">
              <button
                class="btn primary"
                data-publish-submit
                ?disabled=${!this.ready}
                @click=${() => void this.publish()}
              >
                ${this.attempted
                  ? t("bulkPublishRetry")
                  : t("bulkPublishConfirm", { count: String(this.entries.length) })}
              </button>
              ${this.phase === "publishing"
                ? html`<button
                    class="btn"
                    ?disabled=${this.stopping}
                    @click=${() => (this.stopping = true)}
                  >
                    ${t("bulkPublishCancel")}
                  </button>`
                : html` ${!this.attempted
                      ? html`<button
                          class="btn"
                          ?disabled=${busy || !this.available}
                          @click=${() => void this.prepare()}
                        >
                          ${t("bulkPublishReload")}
                        </button>`
                      : nothing}
                    <button class="btn" @click=${() => this.close()}>
                      ${t(this.attempted ? "closeDialog" : "cancel")}
                    </button>`}
            </div>
          </section>`,
    });
  }
}
if (!customElements.get("platformclaw-vault-document-bulk-publish")) {
  customElements.define(
    "platformclaw-vault-document-bulk-publish",
    PlatformClawVaultDocumentBulkPublish,
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "platformclaw-vault-document-bulk-publish": PlatformClawVaultDocumentBulkPublish;
  }
}
