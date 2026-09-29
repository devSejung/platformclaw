import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type {
  KnowledgeVaultDocument,
  KnowledgeVaultDocumentSummary,
  KnowledgeVaultCompile,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import {
  compactKnowledgeRevision,
  renderKnowledgeDocumentCard,
} from "../components/knowledge-document-card.ts";
import { renderKnowledgeDocumentReader } from "../components/knowledge-document-reader.ts";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import "../components/modal-dialog.ts";
import "../styles/dreams.css";
import "./memory-vaults.css";
import { platformClawT } from "./i18n.ts";

export function renderVaultDocument(options: {
  document: KnowledgeVaultDocument;
  vaultName: string;
  vaultType: "personal" | "shared";
  canExport: boolean;
  onPublish?: () => void;
  onDelete?: () => void;
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
  return renderKnowledgeDocumentReader({
    title: document.title,
    vaultDocument: true,
    metadata: html`${options.vaultName} ·
    ${platformClawT("memoryPage.memories.revision", {
      revision: compactKnowledgeRevision(document.revision),
    })}`,
    closeLabel: t("close"),
    onClose: options.onClose,
    actions: html`
      ${options.onDelete
        ? html`<button
            class="btn btn--subtle btn--sm danger"
            ?disabled=${options.busy}
            @click=${options.onDelete}
          >
            ${t("deleteDocument")}
          </button>`
        : nothing}
      ${options.canEdit
        ? html`<button
            class="btn btn--subtle btn--sm"
            ?disabled=${options.busy}
            @click=${options.onEdit}
          >
            ${t("edit")}
          </button>`
        : nothing}
      ${options.onPublish
        ? html`<button
            class="btn btn--subtle btn--sm"
            ?disabled=${options.busy}
            @click=${options.onPublish}
          >
            ${t("publish")}
          </button>`
        : nothing}
      ${options.canExport
        ? html`<button
            class="btn btn--subtle btn--sm"
            ?disabled=${options.busy}
            @click=${options.onDownload}
          >
            ${t("download")}
          </button>`
        : nothing}
    `,
    content: html`<div>
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
                  new URL(path, `https://vault.invalid/${document.logicalPath}`).pathname.slice(1),
                );
          } catch {
            return;
          }
          // Resolution, ambiguity and access belong to the server. Match the
          // original parsed target, not a label or the resolved document path.
          const matches = document.links.filter((candidate) => candidate.target === logicalPath);
          const ids = new Set(matches.map((candidate) => candidate.documentId));
          const id = ids.size === 1 ? ids.values().next().value : null;
          if (id && !options.busy) {
            options.onOpen(id);
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
      ${document.linksTruncated
        ? html`<p class="callout" role="status">${t("linksTruncated")}</p>`
        : nothing}
      ${document.links.some((link) => !link.documentId)
        ? html`<p class="callout" role="status">${t("unresolvedNotice")}</p>`
        : nothing}
      <details class="vaults__relationships">
        <summary>${t("relationships")}</summary>
        ${links("links")}${links("backlinks")}
      </details>
      <details class="vaults__relationships">
        <summary>${t("documentDetails")}</summary>
        <p>
          ${t(options.vaultType)} ·
          ${platformClawT("memoryPage.memories.revision", { revision: String(document.revision) })}
        </p>
        <p>${document.logicalPath}</p>
        <p>${document.vaultId} · ${document.id}</p>
        ${document.metadata
          ? html`${(["claims", "questions", "contradictions"] as const).map((kind) =>
              document.metadata![kind].length
                ? html`<h4>${t(kind)}</h4>
                    <ul>
                      ${document.metadata![kind].map((value) => html`<li>${value}</li>`)}
                    </ul>`
                : nothing,
            )}`
          : nothing}
      </details>
    </div>`,
  });
}

export function renderVaultDocumentList(options: {
  documents: KnowledgeVaultDocumentSummary[];
  vaultName: string;
  vaultType: "personal" | "shared";
  canEdit: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
}) {
  const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
  return html`
    ${options.documents.length === 0
      ? html`<p>${t(options.canEdit ? "noDocuments" : "readerEmpty")}</p>`
      : html`<div class="settings-group memory-memories__results">
          ${options.documents.map((document) =>
            renderKnowledgeDocumentCard({
              title: document.title,
              snippet: document.snippet,
              metadata: html`<span class="settings-row__desc">${options.vaultName}</span>`,
              modal: true,
              disabled: options.busy,
              onOpen: () => options.onOpen(document.id),
              status:
                document.compile.status !== "ready"
                  ? html`<span class="settings-row__desc" role="status"
                      >${t(document.compile.status)}</span
                    >`
                  : nothing,
              details:
                document.compile.status !== "ready"
                  ? renderVaultIndexStatus(document.compile)
                  : nothing,
            }),
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
