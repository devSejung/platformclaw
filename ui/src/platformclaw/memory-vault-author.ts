import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type {
  KnowledgeVault,
  KnowledgeVaultCatalogEntry,
  KnowledgeVaultDocument,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { renderHubTabs } from "../components/hub-tabs.ts";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "../pages/config/memory-promotion-source-picker.ts";
import type { PersonalWikiSourceSelected } from "../pages/config/memory-promotion-source-picker.ts";
import { platformClawT } from "./i18n.ts";
import { renderVaultDialog } from "./memory-vault-catalog.ts";
import "./memory-vaults.css";

const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
type SourceKind = "write" | "personal" | "upload";
export type VaultAuthorSaved = {
  vaultId: string;
  vaultName: string;
  document: KnowledgeVaultDocument;
  published: boolean;
};

class PlatformClawVaultAuthor extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ attribute: false }) methods: readonly string[] = [];
  @property() agentId: string | null = null;
  @property({ attribute: false }) vault: KnowledgeVault | KnowledgeVaultCatalogEntry | null = null;
  @property({ attribute: false }) document: KnowledgeVaultDocument | null = null;
  @property() initialPersonalLookup: string | null = null;
  @state() private vaults: Array<KnowledgeVault | KnowledgeVaultCatalogEntry> = [];
  @state() private vaultId = "";
  @state() private sourceKind: SourceKind = "write";
  @state() private source: (PersonalWikiSourceSelected & { revision: string }) | null = null;
  @state() private documentTitle = "";
  @state() private content = "";
  @state() private path = "";
  @state() private suggestedPath = "";
  @state() private filename = "";
  @state() private reviewing = false;
  @state() private busy = false;
  @state() private error = "";
  @state() private pendingDiscard: (() => void) | null = null;
  @state() private choosingPersonal = false;
  private baseline = "";
  private epoch = 0;
  private sourceSelection = 0;
  private readonly preventDirtyUnload = (event: BeforeUnloadEvent) => {
    if (this.draftKey() !== this.baseline) {
      event.preventDefault();
      event.returnValue = "";
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("beforeunload", this.preventDirtyUnload);
  }

  protected override updated(changed: PropertyValues) {
    if (
      ["client", "connected", "agentId", "vault", "document", "initialPersonalLookup"].some((key) =>
        changed.has(key),
      )
    ) {
      this.epoch++;
      this.busy = false;
      this.error = "";
      this.vaults = this.vault ? [this.vault] : [];
      this.vaultId = this.vault?.id ?? "";
      this.sourceKind = this.initialPersonalLookup ? "personal" : "write";
      this.source = null;
      this.documentTitle = this.document?.title ?? "";
      this.content = this.document?.content ?? "";
      this.path = this.document?.logicalPath ?? "";
      this.suggestedPath = "";
      this.filename = "";
      this.reviewing = false;
      this.pendingDiscard = null;
      this.choosingPersonal = false;
      this.baseline = this.draftKey();
      if (!this.vault && this.client && this.connected) {
        void this.run(async (epoch) => {
          const snapshot = await this.client!.request<KnowledgeVaultSnapshot>(
            "platformclaw.vault.snapshot",
            {},
          );
          if (epoch !== this.epoch) {
            return;
          }
          this.vaults = snapshot.vaults.filter((vault) => vault.type === "shared" && vault.canEdit);
          if (this.vaults.length === 1) {
            this.vaultId = this.vaults[0]!.id;
          }
        });
      }
    }
  }
  override disconnectedCallback() {
    window.removeEventListener("beforeunload", this.preventDirtyUnload);
    this.epoch++;
    super.disconnectedCallback();
  }
  private async run(action: (epoch: number) => Promise<void>) {
    if (!this.client || !this.connected || this.busy) {
      return;
    }
    const epoch = this.epoch;
    this.busy = true;
    this.error = "";
    try {
      await action(epoch);
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
  private close() {
    if (this.pendingDiscard) {
      this.pendingDiscard = null;
      return false;
    }
    return this.guardDraft(() =>
      this.dispatchEvent(new CustomEvent("author-close", { bubbles: true })),
    );
  }
  private draftKey() {
    return JSON.stringify([this.documentTitle, this.content, this.path]);
  }
  private guardDraft(action: () => void) {
    if (this.busy) {
      return false;
    }
    if (this.draftKey() !== this.baseline) {
      this.pendingDiscard = action;
      return false;
    }
    action();
    return true;
  }
  private chooseSource(kind: SourceKind) {
    if (kind === this.sourceKind) {
      return;
    }
    this.guardDraft(() => this.resetSource(kind));
  }
  private resetSource(kind: SourceKind) {
    this.sourceSelection++;
    this.sourceKind = kind;
    this.source = null;
    this.documentTitle =
      this.content =
      this.path =
      this.filename =
      this.suggestedPath =
      this.error =
        "";
    this.reviewing = false;
    this.choosingPersonal = false;
    this.baseline = this.draftKey();
  }
  private selectPersonal(value: PersonalWikiSourceSelected) {
    this.guardDraft(() => this.loadPersonal(value));
  }
  private loadPersonal(value: PersonalWikiSourceSelected) {
    const epoch = this.epoch;
    const selection = ++this.sourceSelection;
    void (async () => {
      if (typeof value.sourceContent !== "string") {
        throw new Error(t("sourceUnavailable"));
      }
      if (!globalThis.crypto?.subtle) {
        throw new Error(t("secureContext"));
      }
      // Pin the full original separately from the editable copy. Publishing never edits Personal.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value.sourceContent),
      );
      if (epoch !== this.epoch || selection !== this.sourceSelection) {
        return;
      }
      this.source = {
        ...value,
        revision: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      };
      this.documentTitle = value.title;
      this.content = value.sourceContent;
      this.path = "";
      this.reviewing = false;
      this.choosingPersonal = false;
      this.baseline = this.draftKey();
    })().catch((error: unknown) => {
      if (epoch === this.epoch && selection === this.sourceSelection) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    });
  }
  private async preview(epoch: number) {
    const clean = this.draftKey() === this.baseline;
    const result = await this.client!.request<{ title: string; logicalPath: string }>(
      "platformclaw.vault.document.preview",
      {
        vaultId: this.vaultId,
        content: this.content,
        ...(this.documentTitle.trim() ? { title: this.documentTitle } : {}),
        ...(this.filename ? { filename: this.filename } : {}),
        ...(this.path.trim() ? { logicalPath: this.path } : {}),
      },
    );
    if (epoch !== this.epoch) {
      return;
    }
    this.documentTitle = result.title;
    // Suggested paths are display-only; only an explicit advanced override goes to save.
    this.suggestedPath = result.logicalPath;
    this.reviewing = true;
    if (clean) {
      this.baseline = this.draftKey();
    }
  }
  private upload(file: File) {
    this.guardDraft(() => this.loadUpload(file));
  }
  private loadUpload(file: File) {
    void this.run(async (epoch) => {
      if (file.size > 1024 * 1024) {
        throw new Error(t("tooLarge"));
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw new Error(t("invalidUtf8"));
      }
      if (epoch !== this.epoch) {
        return;
      }
      this.content = content;
      this.filename = file.name;
      this.documentTitle = this.path = "";
      this.baseline = this.draftKey();
      await this.preview(epoch);
    });
  }
  private submit(event: SubmitEvent) {
    event.preventDefault();
    void this.run(async (epoch) => {
      if (!this.reviewing) {
        await this.preview(epoch);
        return;
      }
      const shared = { title: this.documentTitle, content: this.content };
      const document = this.source
        ? await this.client!.request<KnowledgeVaultDocument>("platformclaw.vault.publish", {
            targetVaultId: this.vaultId,
            lookup: this.source.lookup,
            expectedRevision: this.source.revision,
            ...shared,
            ...(this.path.trim() ? { path: this.path } : {}),
          })
        : await this.client!.request<KnowledgeVaultDocument>("platformclaw.vault.document.save", {
            vaultId: this.vaultId,
            ...shared,
            ...(this.path.trim() ? { logicalPath: this.path } : {}),
            ...(this.filename ? { filename: this.filename } : {}),
            ...(this.document
              ? { documentId: this.document.id, expectedRevision: this.document.revision }
              : {}),
          });
      if (epoch !== this.epoch) {
        return;
      }
      this.dispatchEvent(
        new CustomEvent<VaultAuthorSaved>("author-saved", {
          bubbles: true,
          detail: {
            vaultId: this.vaultId,
            vaultName: this.vaults.find((vault) => vault.id === this.vaultId)!.name,
            document,
            published: Boolean(this.source),
          },
        }),
      );
    });
  }
  override render() {
    const ready = Boolean(
      this.vaultId &&
      (this.sourceKind !== "personal" || this.source) &&
      (this.sourceKind !== "upload" || this.filename),
    );
    return renderVaultDialog({
      title: t(
        this.pendingDiscard
          ? "discardTitle"
          : this.document
            ? "edit"
            : this.initialPersonalLookup
              ? "publish"
              : "addKnowledge",
      ),
      busy: this.busy,
      error: this.error,
      onClose: () => this.close(),
      content: this.pendingDiscard
        ? html` <p>${t("discardDescription")}</p>
            <div class="vaults__actions">
              <button class="btn primary" autofocus @click=${() => (this.pendingDiscard = null)}>
                ${t("keepEditing")}
              </button>
              <button
                class="btn danger"
                @click=${() => {
                  const action = this.pendingDiscard;
                  this.pendingDiscard = null;
                  action?.();
                }}
              >
                ${t("discard")}
              </button>
            </div>`
        : html` ${this.vault
              ? html`<p class="vaults__hint">${this.vault.name}</p>`
              : html`<label class="vaults__select"
                    >${t("choose")}
                    <select
                      class="settings-select"
                      .value=${this.vaultId}
                      ?disabled=${this.busy}
                      @change=${(event: Event) => {
                        this.vaultId = (event.currentTarget as HTMLSelectElement).value;
                        this.reviewing = false;
                      }}
                    >
                      <option value="">${t("choose")}</option>
                      ${this.vaults.map(
                        (vault) => html`<option value=${vault.id}>${vault.name}</option>`,
                      )}
                    </select></label
                  >${!this.vaults.length && !this.busy
                    ? html`<p role="status">${t("noEditableVault")}</p>`
                    : nothing}`}
            ${!this.document && !this.initialPersonalLookup
              ? renderHubTabs<SourceKind>({
                  id: "vault-author-source",
                  active: this.sourceKind,
                  variant: "sub",
                  ariaLabel: t("addKnowledge"),
                  panelId: "vault-author-content",
                  tabs: [
                    { value: "write", label: t("newDocument") },
                    ...(this.methods.includes("platformclaw.vault.publish") &&
                    this.methods.includes("wiki.search") &&
                    this.methods.includes("wiki.document.get")
                      ? [{ value: "personal" as const, label: t("personalSource") }]
                      : []),
                    { value: "upload", label: t("uploadMarkdown") },
                  ],
                  onSelect: (kind) => {
                    if (!this.busy) {
                      this.chooseSource(kind);
                    }
                  },
                })
              : nothing}
            <div
              id="vault-author-content"
              role=${!this.document && !this.initialPersonalLookup ? "tabpanel" : nothing}
              aria-labelledby=${!this.document && !this.initialPersonalLookup
                ? `vault-author-source-tab-${this.sourceKind}`
                : nothing}
            >
              ${this.sourceKind === "personal"
                ? html`<p class="vaults__hint">${t("publishHint")}</p>
                    ${this.source && !this.choosingPersonal
                      ? html`<p class="vaults__hint">
                            ${t("selectedPersonalSource")}: <strong>${this.source.title}</strong>
                          </p>
                          ${!this.initialPersonalLookup
                            ? html`<button
                                class="btn btn--sm"
                                @click=${() => (this.choosingPersonal = true)}
                              >
                                ${t("changeSource")}
                              </button>`
                            : nothing}`
                      : html`<openclaw-memory-promotion-source-picker
                          .client=${this.client}
                          .connected=${this.connected}
                          .agentId=${this.agentId}
                          .searchAdvertised=${this.methods.includes("wiki.search")}
                          .getAdvertised=${this.methods.includes("wiki.document.get")}
                          .initialPersonalLookup=${this.initialPersonalLookup}
                          .showPreview=${false}
                          .inert=${this.busy}
                          @source-selected=${(event: CustomEvent<PersonalWikiSourceSelected>) =>
                            this.selectPersonal(event.detail)}
                          @source-cleared=${() => {
                            this.sourceSelection++;
                          }}
                        ></openclaw-memory-promotion-source-picker>`}`
                : nothing}
              ${this.sourceKind === "upload"
                ? html`<p class="vaults__hint">${t("markdownHint")}</p>
                    <label class="btn vaults__upload"
                      >${t("chooseMarkdown")}<input
                        type="file"
                        accept=".md,.markdown,text/markdown"
                        ?disabled=${this.busy || !this.vaultId}
                        @change=${(event: Event) => {
                          const input = event.currentTarget as HTMLInputElement;
                          const file = input.files?.[0];
                          input.value = "";
                          if (file) {
                            this.upload(file);
                          }
                        }} /></label
                    >${this.filename ? html`<p class="vaults__hint">${this.filename}</p>` : nothing}`
                : nothing}
              ${ready
                ? html`<form
                    class="vaults__form"
                    data-vault-editor
                    @submit=${(event: SubmitEvent) => this.submit(event)}
                  >
                    <label
                      >${t("documentTitle")}<input
                        class="settings-input"
                        name="title"
                        .value=${this.documentTitle}
                        placeholder=${t("automaticTitle")}
                        ?disabled=${this.busy}
                        @input=${(event: Event) => {
                          this.documentTitle = (event.currentTarget as HTMLInputElement).value;
                          this.reviewing = false;
                        }}
                    /></label>
                    <div class="vaults__actions">
                      <button
                        class="btn btn--sm"
                        type="button"
                        aria-pressed=${String(!this.reviewing)}
                        ?disabled=${this.busy}
                        @click=${() => (this.reviewing = false)}
                      >
                        ${t("writeCopy")}</button
                      ><button
                        class="btn btn--sm"
                        type="button"
                        aria-pressed=${String(this.reviewing)}
                        ?disabled=${this.busy}
                        @click=${() => void this.run((epoch) => this.preview(epoch))}
                      >
                        ${t("previewCopy")}
                      </button>
                    </div>
                    ${this.reviewing
                      ? html`<article
                            class="sidebar-markdown wiki-document__reader vaults__author-preview"
                          >
                            ${unsafeHTML(
                              toSanitizedMarkdownHtml(this.content, {
                                fileLinks: false,
                                interactiveImages: false,
                                codeBlockChrome: "none",
                              }),
                            )}
                          </article>
                          <p class="vaults__hint">${t("linkReviewHint")}</p>`
                      : html`<label
                          >${t("body")}<textarea
                            class="settings-input"
                            name="content"
                            rows="12"
                            .value=${this.content}
                            ?disabled=${this.busy}
                            @input=${(event: Event) => {
                              this.content = (event.currentTarget as HTMLTextAreaElement).value;
                            }}
                          ></textarea>
                        </label>`}
                    <details>
                      <summary>${t("advancedPath")}</summary>
                      <label
                        >${t("path")}<input
                          class="settings-input"
                          name="path"
                          .value=${this.path}
                          placeholder=${this.suggestedPath || t("automaticPath")}
                          ?disabled=${this.busy}
                          @input=${(event: Event) => {
                            this.path = (event.currentTarget as HTMLInputElement).value;
                            this.reviewing = false;
                          }}
                      /></label>
                      <p class="vaults__hint">${t("automaticPathHint")}</p>
                    </details>
                    <div class="vaults__actions">
                      <button class="btn primary" ?disabled=${this.busy}>
                        ${t(
                          this.reviewing
                            ? this.source
                              ? "publishConfirm"
                              : "save"
                            : "previewCopy",
                        )}</button
                      ><button
                        class="btn"
                        type="button"
                        ?disabled=${this.busy}
                        @click=${() => this.close()}
                      >
                        ${t("cancel")}
                      </button>
                    </div>
                  </form>`
                : nothing}
            </div>`,
    });
  }
}
if (!customElements.get("platformclaw-vault-author")) {
  customElements.define("platformclaw-vault-author", PlatformClawVaultAuthor);
}
