import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type {
  KnowledgeVaultDocument,
  KnowledgeVaultDocumentSummary,
  KnowledgeVaultCompile,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { platformClawT } from "./i18n.ts";

export function renderVaultDocument(options: {
  document: KnowledgeVaultDocument;
  vaultName: string;
  canEdit: boolean;
  busy: boolean;
  onOpen: (documentId: string) => void;
  onEdit: () => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  const { document } = options;
  const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
  const links = (kind: "links" | "backlinks") =>
    html`<div>
      <h4>${t(kind)}</h4>
      ${document[kind].map((link) =>
        link.documentId
          ? html`<button
              class="btn btn--sm"
              ?disabled=${options.busy}
              @click=${() => options.onOpen(link.documentId!)}
            >
              ${link.title} · ${link.logicalPath}
            </button>`
          : html`<span>${link.logicalPath}</span>`,
      )}
    </div>`;
  return html`<article class="card" data-vault-document>
    <h3>${document.title}</h3>
    <p class="muted">
      ${options.vaultName} · Shared · ${document.vaultId} · ${document.id} · ${document.logicalPath}
      · r${document.revision}
    </p>
    <div class="vaults__actions">
      ${options.canEdit
        ? html`<button class="btn" ?disabled=${options.busy} @click=${options.onEdit}>
            ${t("edit")}
          </button>`
        : nothing}
      <button class="btn" ?disabled=${options.busy} @click=${options.onDownload}>
        ${t("download")}
      </button>
      <button class="btn" @click=${options.onClose}>${t("close")}</button>
    </div>
    <div class="sidebar-markdown">
      ${unsafeHTML(
        toSanitizedMarkdownHtml(document.content, {
          fileLinks: false,
          interactiveImages: false,
          codeBlockChrome: "none",
        }),
      )}
    </div>
    ${links("links")}${links("backlinks")}
  </article>`;
}

export function renderVaultDocumentList(options: {
  documents: KnowledgeVaultDocumentSummary[];
  busy: boolean;
  onOpen: (id: string) => void;
}) {
  const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
  return html`
    ${options.documents.length === 0
      ? html`<p>${t("noDocuments")}</p>`
      : html`<div class="vaults__documents">
          ${options.documents.map(
            (document) => html`<article class="card" data-vault-index=${document.compile.status}>
              <button
                class="btn"
                ?disabled=${options.busy}
                @click=${() => options.onOpen(document.id)}
              >
                ${document.title}
              </button>
              <p class="muted">
                ${document.logicalPath} · r${document.revision} · ${t(document.compile.status)}
              </p>
              ${document.compile.status !== "ready"
                ? renderVaultIndexStatus(document.compile)
                : nothing}
            </article>`,
          )}
        </div>`}
  `;
}

export function renderVaultIndexStatus(compile: KnowledgeVaultCompile) {
  const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
  return html`<div class="vaults__form" data-vault-compile-detail>
    <p>${t(compile.indexedRevision === null ? "indexMissing" : "indexPreserved")}</p>
    <p class="vaults__hint">${t("indexDefinition")}</p>
    <p class="vaults__hint">${t("indexRetry")}</p>
    <details>
      <summary>${t("indexDetails")}</summary>
      <p>${t("indexedRevision")}: ${compile.indexedRevision ?? "—"}</p>
      ${compile.error ? html`<p role="alert">${compile.error}</p>` : nothing}
      ${compile.retryAt
        ? html`<p>${t("retryAt")}: ${new Date(compile.retryAt).toLocaleString()}</p>`
        : nothing}
    </details>
  </div>`;
}
