import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import {
  KNOWLEDGE_VAULT_LIMITS,
  type KnowledgeVaultDocumentImportResult,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { formatBytes } from "../lib/agents/display.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { generateUUID } from "../lib/uuid.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT } from "./i18n.ts";
import "./memory-vault-upload.css";

const t = (key: string, params?: Record<string, string>) =>
  platformClawT(`platformClaw.vault.${key}`, params);
type UploadEntry = { relativePath: string; size: number } & (
  | { status: "excluded" | "invalid"; message: string }
  | { status: "ready" | "uploading" | "uncertain"; content: string }
  | { status: "failed"; content: string; error: "conflict" | "unavailable" | "invalid" }
  | { status: "saved" | "unchanged"; content: string; path: string }
);
type PendingEntry = Extract<UploadEntry, { content: string }>;

export type VaultUploadSummary = {
  vaultId: string;
  saved: number;
  unchanged: number;
  failed: number;
  excluded: number;
  indexesRefreshed: boolean;
};

function canUpload(entry: UploadEntry): entry is PendingEntry {
  return (
    entry.status === "ready" ||
    (entry.status === "failed" && entry.error !== "invalid") ||
    entry.status === "uncertain"
  );
}

function importPathIssue(relativePath: string): string | null {
  const path = relativePath.normalize("NFC").replace(/\.(?:md|markdown)$/iu, ".md");
  // Mirror the source owner's portable path contract before assigning a retry root.
  const segments = path.split("/");
  if (
    path.length + "concepts/imports/".length + 36 + 1 > 512 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        new TextEncoder().encode(segment).length > 190 ||
        /[<>:"\\|?*]/u.test(segment) ||
        segment
          .split("")
          .some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
        /[. ]$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    )
  ) {
    return t("importInvalidPath");
  }
  return null;
}

export class PlatformClawVaultUpload extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property() vaultId = "";
  @state() private entries: UploadEntry[] = [];
  @state() private phase: "idle" | "reading" | "uploading" = "idle";
  @state() private error = "";
  @state() private previewPath = "";
  @state() private pendingLeave: (() => void) | null = null;
  @state() private indexesRefreshed: boolean | null = null;
  private importId = "";
  private operation = 0;
  private readonly preventPendingUnload = (event: BeforeUnloadEvent) => {
    if (this.phase === "uploading" || this.hasPending) {
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
    window.removeEventListener("beforeunload", this.preventPendingUnload);
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues) {
    if (changed.has("client") || changed.has("vaultId")) {
      this.operation++;
      this.entries = [];
      this.importId = "";
      this.error = "";
      this.previewPath = "";
      this.pendingLeave = null;
      this.indexesRefreshed = null;
      this.phase = "idle";
    } else if (changed.has("connected") && this.phase === "uploading") {
      this.operation++;
      this.markUncertain();
      this.error = t("importInterrupted");
      this.phase = "idle";
    }
    if (changed.has("phase")) {
      this.dispatchEvent(
        new CustomEvent("upload-busy", { bubbles: true, detail: this.phase !== "idle" }),
      );
    }
  }
  private get hasPending() {
    return this.entries.some(canUpload);
  }
  requestLeave(action: () => void) {
    if (this.phase !== "idle") {
      return false;
    }
    if (this.pendingLeave) {
      this.pendingLeave = null;
      return false;
    }
    if (this.hasPending) {
      this.pendingLeave = action;
      return false;
    }
    action();
    return true;
  }
  private async selectFiles(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!files.length || this.phase !== "idle") {
      return;
    }
    if (files.length + this.entries.length > KNOWLEDGE_VAULT_LIMITS.files) {
      this.error = t("importFileLimit", { count: String(KNOWLEDGE_VAULT_LIMITS.files) });
      return;
    }
    const eligible = files.filter(
      (file) =>
        /\.(?:md|markdown)$/iu.test(file.name) && file.size <= KNOWLEDGE_VAULT_LIMITS.documentBytes,
    );
    const totalBytes =
      this.entries.reduce((sum, entry) => sum + ("content" in entry ? entry.size : 0), 0) +
      eligible.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > KNOWLEDGE_VAULT_LIMITS.expandedBytes) {
      this.error = t("importTotalLimit", {
        size: formatBytes(KNOWLEDGE_VAULT_LIMITS.expandedBytes),
      });
      return;
    }
    const operation = ++this.operation;
    const paths = new Set(
      this.entries
        .filter((entry) => "content" in entry)
        .map((entry) =>
          entry.relativePath
            .normalize("NFC")
            .replace(/\.(?:md|markdown)$/iu, ".md")
            .toLowerCase(),
        ),
    );
    const added: UploadEntry[] = [];
    this.error = "";
    this.phase = "reading";
    for (const file of files) {
      // The selected folder is the import root. Preserve its subtree so root Wiki
      // targets and relative Markdown links refer to the same uploaded documents.
      const relativePath = file.webkitRelativePath
        ? file.webkitRelativePath.slice(file.webkitRelativePath.indexOf("/") + 1)
        : file.name;
      const base = { relativePath, size: file.size };
      const path = relativePath
        .normalize("NFC")
        .replace(/\.(?:md|markdown)$/iu, ".md")
        .toLowerCase();
      const pathIssue = importPathIssue(relativePath);
      if (!/\.(?:md|markdown)$/iu.test(relativePath)) {
        added.push({ ...base, status: "excluded", message: t("importMarkdownOnly") });
      } else if (pathIssue) {
        added.push({ ...base, status: "invalid", message: pathIssue });
      } else if (paths.has(path)) {
        added.push({ ...base, status: "invalid", message: t("importDuplicate") });
      } else if (file.size > KNOWLEDGE_VAULT_LIMITS.documentBytes) {
        added.push({ ...base, status: "invalid", message: t("importDocumentLimit") });
      } else {
        paths.add(path);
        try {
          const bytes = await file.arrayBuffer();
          if (bytes.byteLength > KNOWLEDGE_VAULT_LIMITS.documentBytes) {
            added.push({ ...base, status: "invalid", message: t("importDocumentLimit") });
          } else {
            const content = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(
              bytes,
            );
            added.push({ ...base, size: bytes.byteLength, status: "ready", content });
          }
        } catch {
          added.push({ ...base, status: "invalid", message: t("invalidUtf8") });
        }
      }
      if (operation !== this.operation) {
        return;
      }
    }
    this.entries = [...this.entries, ...added];
    this.phase = "idle";
  }
  private markUncertain() {
    this.entries = this.entries.map((entry) =>
      entry.status === "uploading" ? { ...entry, status: "uncertain" } : entry,
    );
  }
  private summary(): VaultUploadSummary {
    return {
      vaultId: this.vaultId,
      saved: this.entries.filter((entry) => entry.status === "saved").length,
      unchanged: this.entries.filter((entry) => entry.status === "unchanged").length,
      failed: this.entries.filter(
        (entry) =>
          entry.status === "failed" || entry.status === "uncertain" || entry.status === "invalid",
      ).length,
      excluded: this.entries.filter((entry) => entry.status === "excluded").length,
      indexesRefreshed: this.indexesRefreshed === true,
    };
  }
  private async upload() {
    if (!this.client || !this.connected || this.phase !== "idle" || !this.hasPending) {
      return;
    }
    try {
      this.importId ||= generateUUID();
    } catch {
      this.error = t("importCryptoUnavailable");
      return;
    }
    // A lost reply can still mean files were saved. Retain the same root for every retry.
    const importId = this.importId;
    const operation = ++this.operation;
    const pending = this.entries.filter(canUpload);
    this.phase = "uploading";
    this.error = "";
    try {
      while (pending.length) {
        let bytes = 0;
        const batch: PendingEntry[] = [];
        while (
          pending.length &&
          batch.length < KNOWLEDGE_VAULT_LIMITS.importDocuments &&
          bytes + pending[0]!.size <= KNOWLEDGE_VAULT_LIMITS.importBytes
        ) {
          const entry = pending.shift()!;
          bytes += entry.size;
          batch.push(entry);
        }
        const paths = new Set(batch.map((entry) => entry.relativePath));
        this.entries = this.entries.map((entry) =>
          canUpload(entry) && paths.has(entry.relativePath)
            ? {
                relativePath: entry.relativePath,
                size: entry.size,
                content: entry.content,
                status: "uploading",
              }
            : entry,
        );
        const result = await this.client.request<KnowledgeVaultDocumentImportResult>(
          "platformclaw.vault.document.import",
          {
            vaultId: this.vaultId,
            importId,
            documents: batch.map(({ relativePath, content }) => ({ relativePath, content })),
          },
        );
        if (operation !== this.operation) {
          return;
        }
        const outcomes = new Map(result.documents.map((entry) => [entry.relativePath, entry]));
        if (
          result.importId !== importId ||
          outcomes.size !== batch.length ||
          batch.some((entry) => !outcomes.has(entry.relativePath))
        ) {
          throw new Error(t("importUnconfirmed"));
        }
        this.entries = this.entries.map((entry) => {
          if (entry.status !== "uploading") {
            return entry;
          }
          const outcome = outcomes.get(entry.relativePath)!;
          return outcome.status === "failed"
            ? { ...entry, status: "failed", error: outcome.error }
            : { ...entry, status: outcome.status, path: outcome.path };
        });
        // A batch containing only failed files skips compilation on the source owner.
        if (
          result.documents.some((entry) => entry.status === "saved" || entry.status === "unchanged")
        ) {
          this.indexesRefreshed = result.indexesRefreshed;
        }
      }
    } catch (error) {
      if (operation !== this.operation) {
        return;
      }
      this.markUncertain();
      this.error = `${t("importInterrupted")} ${formatErrorMessage(error, { redact: redactToolDetail })}`;
    } finally {
      if (operation === this.operation) {
        this.phase = "idle";
        this.dispatchEvent(
          new CustomEvent<VaultUploadSummary>("upload-complete", {
            bubbles: true,
            detail: this.summary(),
          }),
        );
      }
    }
  }
  private status(entry: UploadEntry) {
    if (entry.status === "invalid" || entry.status === "excluded") {
      return entry.message;
    }
    if (entry.status === "failed") {
      return t(
        entry.error === "invalid"
          ? "importInvalidMarkdown"
          : entry.error === "conflict"
            ? "importConflict"
            : "importFailed",
      );
    }
    return t(`importStatus.${entry.status}`);
  }
  override render() {
    if (this.pendingLeave) {
      return html`<div class="vaults__batch">
        <p>${t("importDiscard")}</p>
        <div class="vaults__actions">
          <button class="btn primary" @click=${() => (this.pendingLeave = null)}>
            ${t("keepEditing")}
          </button>
          <button
            class="btn"
            @click=${() => {
              const leave = this.pendingLeave;
              this.pendingLeave = null;
              leave?.();
            }}
          >
            ${t("discard")}
          </button>
        </div>
      </div>`;
    }
    const busy = this.phase !== "idle";
    const summary = this.summary();
    const completed =
      summary.saved +
      summary.unchanged +
      this.entries.filter((entry) => entry.status === "failed").length;
    const total = this.entries.filter((entry) => "content" in entry).length;
    const preview = this.entries.find(
      (entry) => entry.relativePath === this.previewPath && "content" in entry,
    );
    return html`<section class="vaults__batch" data-vault-upload>
      <div class="vaults__batch-pick">
        <strong>${t("importHeading")}</strong>
        <p class="vaults__hint">${t("importMarkdownHint")}</p>
        <div class="vaults__actions">
          <label class="btn primary vaults__upload" aria-disabled=${String(busy)}
            >${t("importChooseFiles")}<input
              type="file"
              accept=".md,.markdown,text/markdown"
              multiple
              ?disabled=${busy}
              @change=${(event: Event) => void this.selectFiles(event)}
          /></label>
          <label class="btn vaults__upload" aria-disabled=${String(busy)}
            >${t("importChooseFolder")}<input
              type="file"
              multiple
              webkitdirectory
              ?disabled=${busy}
              @change=${(event: Event) => void this.selectFiles(event)}
          /></label>
        </div>
        <p class="vaults__hint">
          ${t("importLimits", { count: String(KNOWLEDGE_VAULT_LIMITS.files) })}
        </p>
      </div>
      ${this.error ? html`<p class="callout danger" role="alert">${this.error}</p>` : nothing}
      ${this.entries.length
        ? html`<div class="vaults__batch-summary" role="status" aria-live="polite">
              <strong
                >${t("importSelected", {
                  count: String(this.entries.length),
                  size: formatBytes(
                    this.entries.reduce(
                      (sum, entry) => sum + ("content" in entry ? entry.size : 0),
                      0,
                    ),
                  ),
                })}</strong
              >
              <span class="vaults__hint"
                >${t("importCounts", {
                  saved: String(summary.saved),
                  unchanged: String(summary.unchanged),
                  failed: String(summary.failed),
                  excluded: String(summary.excluded),
                })}</span
              >
            </div>
            <ul class="vaults__batch-list" aria-label=${t("importFileList")}>
              ${this.entries.map(
                (entry, index) => html`<li data-upload-status=${entry.status}>
                  <div class="vaults__batch-file">
                    ${"content" in entry
                      ? html`<button
                          class="vaults__batch-name"
                          type="button"
                          aria-label=${t("importPreviewFile", { path: entry.relativePath })}
                          @click=${() => (this.previewPath = entry.relativePath)}
                        >
                          ${entry.relativePath}
                        </button>`
                      : html`<strong class="vaults__batch-name">${entry.relativePath}</strong>`}
                    <span class="vaults__hint"
                      >${formatBytes(entry.size)} · ${this.status(entry)}</span
                    >
                  </div>
                  ${entry.status !== "saved" && entry.status !== "unchanged"
                    ? html`<button
                        class="btn btn--sm"
                        ?disabled=${busy}
                        aria-label=${t("importRemoveFile", { path: entry.relativePath })}
                        @click=${() => {
                          this.entries = this.entries.filter((_, position) => position !== index);
                          this.previewPath = "";
                        }}
                      >
                        ${t("importRemove")}
                      </button>`
                    : nothing}
                </li>`,
              )}
            </ul>`
        : nothing}
      ${preview && "content" in preview
        ? html`<details class="vaults__batch-preview" open>
            <summary>${t("importSourcePreview")}: ${preview.relativePath}</summary>
            <pre class="vaults__source">${preview.content}</pre>
          </details>`
        : nothing}
      ${busy
        ? html`<div class="vaults__batch-progress" role="status">
            <span
              >${this.phase === "reading"
                ? t("importReading")
                : t("importProgress", { completed: String(completed), total: String(total) })}</span
            >
            ${this.phase === "reading"
              ? html`<progress aria-label=${t("importReading")}></progress>`
              : html`<progress
                  value=${completed}
                  max=${total || 1}
                  aria-label=${t("importUploading")}
                ></progress>`}
          </div>`
        : nothing}
      ${this.indexesRefreshed === false && summary.saved + summary.unchanged > 0
        ? html`<p class="callout" role="status">${t("importIndexPending")}</p>`
        : nothing}
      ${this.importId ? html`<p class="vaults__hint">${t("importRetryHint")}</p>` : nothing}
      <div class="vaults__actions">
        ${this.hasPending || this.phase === "uploading"
          ? html`<button
              class="btn primary"
              data-upload-submit
              ?disabled=${busy || !this.connected}
              @click=${() => void this.upload()}
            >
              ${this.phase === "uploading"
                ? t("importUploading")
                : this.importId
                  ? t("importRetry")
                  : t("importUpload", { count: String(this.entries.filter(canUpload).length) })}
            </button>`
          : nothing}
        <button
          class="btn"
          ?disabled=${busy}
          @click=${() =>
            this.requestLeave(() =>
              this.dispatchEvent(new CustomEvent("upload-close", { bubbles: true })),
            )}
        >
          ${this.importId ? t("importDone") : t("cancel")}
        </button>
      </div>
    </section>`;
  }
}
if (!customElements.get("platformclaw-vault-upload")) {
  customElements.define("platformclaw-vault-upload", PlatformClawVaultUpload);
}
