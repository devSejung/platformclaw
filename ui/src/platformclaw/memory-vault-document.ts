import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type {
  KnowledgeVaultDocument,
  KnowledgeVaultDocumentSummary,
  KnowledgeVaultCompile,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import "../components/modal-dialog.ts";
import "../styles/dreams.css";
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
  return html`<openclaw-modal-dialog
    label=${document.title}
    style="--openclaw-modal-width: 1120px"
    @modal-cancel=${options.onClose}
  >
    <div class="organization-memory-graph__preview dreams-diary__preview-panel" data-vault-document>
      <header class="dreams-diary__preview-header wiki-document__header">
        <div class="wiki-document__heading">
          <div class="dreams-diary__preview-title">${document.title}</div>
          <div class="dreams-diary__preview-meta">
            ${options.vaultName} · ${t("shared")} ·
            ${platformClawT("memoryPage.memories.revision", {
              revision: String(document.revision),
            })}
          </div>
        </div>
        <div class="wiki-document__actions">
          ${options.canEdit
            ? html`<button
                class="btn btn--subtle btn--sm"
                ?disabled=${options.busy}
                @click=${options.onEdit}
              >
                ${t("edit")}
              </button>`
            : nothing}
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${options.busy}
            @click=${options.onDownload}
          >
            ${t("download")}
          </button>
          <button class="btn btn--subtle btn--sm" @click=${options.onClose}>${t("close")}</button>
        </div>
      </header>
      <div class="organization-memory-graph__preview-body dreams-diary__preview-body">
        <p class="vaults__hint">${t(document.compile.status)}</p>
        ${document.compile.status !== "ready" ? renderVaultIndexStatus(document.compile) : nothing}
        <article
          class="md-preview-dialog__reader sidebar-markdown wiki-document__reader"
          @click=${(event: MouseEvent) => {
            const anchor = (event.target as Element).closest<HTMLAnchorElement>(
              "a[href], [data-wiki-lookup]",
            );
            if (!anchor) {
              return;
            }
            const path = anchor.dataset.wikiLookup ?? anchor.getAttribute("href") ?? "";
            if (!anchor.dataset.wikiLookup && /^(?:https?:|#)/iu.test(path)) {
              return;
            }
            event.preventDefault();
            let logicalPath: string;
            try {
              logicalPath = anchor.dataset.wikiLookup
                ? decodeURIComponent(path.split("#")[0]!)
                : decodeURIComponent(
                    new URL(path, `https://vault.invalid/${document.logicalPath}`).pathname.slice(
                      1,
                    ),
                  );
            } catch {
              return;
            }
            const link = document.links.find((candidate) => candidate.logicalPath === logicalPath);
            if (link?.documentId) {
              options.onOpen(link.documentId);
            }
          }}
        >
          ${unsafeHTML(
            toSanitizedMarkdownHtml(document.content, {
              fileLinks: false,
              interactiveImages: false,
              codeBlockChrome: "none",
              wikiLinks: true,
            }),
          )}
        </article>
        ${document.links.some((link) => !link.documentId)
          ? html`<p class="callout" role="status">${t("unresolvedNotice")}</p>`
          : nothing}
        <details class="vaults__relationships">
          <summary>${t("relationships")}</summary>
          ${links("links")}${links("backlinks")}
        </details>
        <details class="vaults__relationships">
          <summary>${t("documentDetails")}</summary>
          <p>${document.logicalPath}</p>
          <p>${document.vaultId} · ${document.id}</p>
        </details>
      </div>
    </div>
  </openclaw-modal-dialog>`;
}

export function renderVaultDocumentList(options: {
  documents: KnowledgeVaultDocumentSummary[];
  canEdit: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
}) {
  const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
  return html`
    ${options.documents.length === 0
      ? html`<p>${t(options.canEdit ? "noDocuments" : "readerEmpty")}</p>`
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
              <p class="muted">${t(document.compile.status)}</p>
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
    <details>
      <summary>${t("indexDetails")}</summary>
      <p class="vaults__hint">${t("indexDefinition")}</p>
      <p class="vaults__hint">${t("indexRetry")}</p>
      <p>${t("indexedRevision")}: ${compile.indexedRevision ?? "—"}</p>
      ${compile.error ? html`<p role="alert">${compile.error}</p>` : nothing}
      ${compile.retryAt
        ? html`<p>${t("retryAt")}: ${new Date(compile.retryAt).toLocaleString()}</p>`
        : nothing}
    </details>
  </div>`;
}
