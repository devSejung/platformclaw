import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../components/modal-dialog.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT as t } from "./i18n.ts";

class PlatformClawMemoryDeleteDialog extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property() agentId = "";
  @property() path = "";
  @property() kind: "memory" | "wiki" = "memory";
  @state() private content = "";
  @state() private contentHash = "";
  @state() private truncated = false;
  @state() private loading = false;
  @state() private deleting = false;
  @state() private error = "";
  private epoch = 0;
  private preview: {
    client: GatewayBrowserClient;
    agentId: string;
    path: string;
    kind: "memory" | "wiki";
    resolvedPath: string;
  } | null = null;

  protected override willUpdate(changed: PropertyValues<this>) {
    if (
      changed.has("client") ||
      changed.has("agentId") ||
      changed.has("path") ||
      changed.has("kind")
    ) {
      void this.loadPreview();
    }
  }

  override disconnectedCallback() {
    this.epoch++;
    super.disconnectedCallback();
  }

  private cancel() {
    if (!this.deleting) {
      this.dispatchEvent(new CustomEvent("delete-cancel", { bubbles: true, composed: true }));
    }
  }

  private async loadPreview() {
    const epoch = ++this.epoch;
    this.content = "";
    this.contentHash = "";
    this.truncated = false;
    this.preview = null;
    this.deleting = false;
    this.error = "";
    this.loading = true;
    const client = this.client;
    const agentId = this.agentId;
    const path = this.path;
    const kind = this.kind;
    if (!client || !this.agentId || !this.path) {
      this.loading = false;
      return;
    }
    try {
      const file =
        kind === "wiki"
          ? await client.request<{
              path: string;
              content: string;
              contentHash?: string;
              truncated?: boolean;
              deletionUnavailableReason?: "shared-vault" | "page-too-large" | "generated-page";
            } | null>("wiki.get", { agentId, lookup: path, fromLine: 1, lineCount: 5000 })
          : (
              await client.request<{
                file: {
                  content: string;
                  contentHash?: string;
                  missing?: boolean;
                  encoding: string;
                };
              }>("agents.workspace.get", { agentId, path })
            ).file;
      if (
        epoch !== this.epoch ||
        !this.isConnected ||
        this.client !== client ||
        this.agentId !== agentId ||
        this.path !== path ||
        this.kind !== kind
      ) {
        return;
      }
      if (
        !file ||
        !file.contentHash ||
        ("missing" in file && file.missing) ||
        ("encoding" in file && file.encoding !== "utf8") ||
        (kind === "wiki" && !("path" in file && file.path))
      ) {
        if (file && "deletionUnavailableReason" in file) {
          if (file.deletionUnavailableReason === "shared-vault") {
            throw new Error(t("platformClaw.wiki.deleteSharedUnavailable"));
          }
          if (file.deletionUnavailableReason === "generated-page") {
            throw new Error(t("platformClaw.wiki.deleteGeneratedUnavailable"));
          }
          if (file.deletionUnavailableReason === "page-too-large") {
            throw new Error(t("platformClaw.wiki.deleteLargeUnavailable"));
          }
        }
        throw new Error(t(this.deleteKey("deleteUnavailable")));
      }
      this.content = file.content;
      this.contentHash = file.contentHash;
      this.truncated = "truncated" in file && file.truncated === true;
      this.preview = {
        client,
        agentId,
        path,
        kind,
        resolvedPath: "path" in file ? file.path : path,
      };
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
      }
    }
  }

  private async deleteFile() {
    const preview = this.preview;
    if (
      !preview ||
      !this.isConnected ||
      preview.client !== this.client ||
      preview.agentId !== this.agentId ||
      preview.path !== this.path ||
      preview.kind !== this.kind ||
      !this.contentHash ||
      this.loading ||
      this.deleting
    ) {
      return;
    }
    const epoch = this.epoch;
    this.deleting = true;
    this.error = "";
    try {
      const result = await preview.client.request<{
        deleted: boolean;
        indexesRefreshed: boolean;
        wikiRefreshed?: boolean;
      }>(preview.kind === "wiki" ? "wiki.delete" : "memory.delete", {
        agentId: this.agentId,
        path: preview.resolvedPath,
        expectedContentHash: this.contentHash,
      });
      if (
        epoch !== this.epoch ||
        !this.isConnected ||
        preview.client !== this.client ||
        preview.agentId !== this.agentId ||
        preview.path !== this.path ||
        preview.kind !== this.kind
      ) {
        return;
      }
      if (!result.deleted) {
        throw new Error(t(this.deleteKey("deleteUnavailable")));
      }
      this.dispatchEvent(
        new CustomEvent("memory-deleted", {
          bubbles: true,
          composed: true,
          detail: { ...result, kind: preview.kind, path: preview.resolvedPath },
        }),
      );
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (epoch === this.epoch) {
        this.deleting = false;
      }
    }
  }

  private deleteKey(suffix: string) {
    return `platformClaw.${this.kind === "wiki" ? "wiki" : "memory"}.${suffix}`;
  }

  override render() {
    return html`<openclaw-modal-dialog
      label=${t(this.deleteKey("delete"))}
      @modal-cancel=${() => this.cancel()}
    >
      <div class="settings-page platformclaw-memory-action-dialog">
        <h2>${t(this.deleteKey("delete"))}: ${this.path}</h2>
        <p>${t(this.deleteKey("deleteDescription"))}</p>
        <p>${t(this.deleteKey("deleteRetention"))}</p>
        ${this.truncated
          ? html`<p role="status">${t("platformClaw.wiki.deletePartialPreview")}</p>`
          : nothing}
        ${this.loading
          ? html`<p role="status">${t("memoryPage.memories.fileLoading")}</p>`
          : nothing}
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        ${this.contentHash
          ? html`<pre class="memory-memories__file" tabindex="0">${this.content}</pre>`
          : nothing}
        <div class="exec-approval-actions">
          <button class="btn" ?disabled=${this.deleting} @click=${() => this.cancel()}>
            ${t("common.cancel")}
          </button>
          <button
            class="btn"
            ?disabled=${this.loading || this.deleting}
            @click=${() => void this.loadPreview()}
          >
            ${t(this.kind === "wiki" ? "common.refresh" : "memoryPage.memories.refresh")}
          </button>
          <button
            class="btn danger"
            ?disabled=${this.loading || this.deleting || !this.contentHash}
            @click=${() => void this.deleteFile()}
          >
            ${t(this.deleteKey("delete"))}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>`;
  }
}

if (!customElements.get("platformclaw-memory-delete-dialog")) {
  customElements.define("platformclaw-memory-delete-dialog", PlatformClawMemoryDeleteDialog);
}
