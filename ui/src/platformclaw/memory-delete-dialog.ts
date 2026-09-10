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
  @state() private content = "";
  @state() private contentHash = "";
  @state() private loading = false;
  @state() private deleting = false;
  @state() private error = "";
  private epoch = 0;
  private preview: { client: GatewayBrowserClient; agentId: string; path: string } | null = null;

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("client") || changed.has("agentId") || changed.has("path")) {
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
    this.preview = null;
    this.deleting = false;
    this.error = "";
    this.loading = true;
    const client = this.client;
    const agentId = this.agentId;
    const path = this.path;
    if (!client || !this.agentId || !this.path) {
      this.loading = false;
      return;
    }
    try {
      const result = await client.request<{
        file: { content: string; contentHash?: string; missing?: boolean; encoding: string };
      }>("agents.workspace.get", { agentId, path });
      if (
        epoch !== this.epoch ||
        !this.isConnected ||
        this.client !== client ||
        this.agentId !== agentId ||
        this.path !== path
      )
        return;
      if (result.file.missing || result.file.encoding !== "utf8" || !result.file.contentHash) {
        throw new Error(t("platformClaw.memory.deleteUnavailable"));
      }
      this.content = result.file.content;
      this.contentHash = result.file.contentHash;
      this.preview = { client, agentId, path };
    } catch (error) {
      if (epoch === this.epoch)
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
    } finally {
      if (epoch === this.epoch) this.loading = false;
    }
  }

  private async deleteFile() {
    const preview = this.preview;
    if (
      !preview ||
      preview.client !== this.client ||
      preview.agentId !== this.agentId ||
      preview.path !== this.path ||
      !this.contentHash ||
      this.loading ||
      this.deleting
    )
      return;
    const epoch = this.epoch;
    this.deleting = true;
    this.error = "";
    try {
      const result = await this.client.request<{
        deleted: boolean;
        indexesRefreshed: boolean;
        wikiRefreshed?: boolean;
      }>("memory.delete", {
        agentId: this.agentId,
        path: this.path,
        expectedContentHash: this.contentHash,
      });
      if (epoch !== this.epoch || !this.isConnected) return;
      if (!result.deleted) throw new Error(t("platformClaw.memory.deleteUnavailable"));
      this.dispatchEvent(
        new CustomEvent("memory-deleted", {
          bubbles: true,
          composed: true,
          detail: { ...result, path: this.path },
        }),
      );
    } catch (error) {
      if (epoch === this.epoch)
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
    } finally {
      if (epoch === this.epoch) this.deleting = false;
    }
  }

  override render() {
    return html`<openclaw-modal-dialog
      label=${t("platformClaw.memory.delete")}
      @modal-cancel=${() => this.cancel()}
    >
      <div class="settings-page platformclaw-memory-action-dialog">
        <h2>${t("platformClaw.memory.delete")}: ${this.path}</h2>
        <p>${t("platformClaw.memory.deleteDescription")}</p>
        <p>${t("platformClaw.memory.deleteRetention")}</p>
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
            ${t("memoryPage.memories.refresh")}
          </button>
          <button
            class="btn danger"
            ?disabled=${this.loading || this.deleting || !this.contentHash}
            @click=${() => void this.deleteFile()}
          >
            ${t("platformClaw.memory.delete")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>`;
  }
}

if (!customElements.get("platformclaw-memory-delete-dialog")) {
  customElements.define("platformclaw-memory-delete-dialog", PlatformClawMemoryDeleteDialog);
}
