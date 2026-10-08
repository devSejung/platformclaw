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

function decodeVaultLinkTarget(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Match the portable parser: literal percent signs remain authored target text.
    return value;
  }
}

export function renderVaultDocument(options: {
  document: KnowledgeVaultDocument;
  vaultName: string;
  vaultType: "personal" | "shared";
  onPublish?: () => void;
  onDelete?: () => void;
  canEdit: boolean;
  busy: boolean;
  linkNotice?: string;
  onOpen: (documentId: string, heading?: string) => void;
  onUnresolvedLink: () => void;
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
      <button class="btn btn--subtle btn--sm" @click=${options.onDownload}>${t("download")}</button>
    `,
    content: html`<div>
      <p class="vaults__hint">${t(document.compile.status)}</p>
      ${document.compile.status !== "ready" ? renderVaultIndexStatus(document.compile) : nothing}
      ${options.linkNotice
        ? html`<p class="callout" role="status">${options.linkNotice}</p>`
        : nothing}
      <article
        class="md-preview-dialog__reader sidebar-markdown wiki-document__reader"
        @click=${(event: MouseEvent) => {
          const anchor = (event.target as Element).closest<HTMLAnchorElement>(
            "a[href], [data-wiki-lookup]",
          );
          if (!anchor) {
            return;
          }
          const wikiLookup = anchor.dataset.wikiLookup;
          const path = wikiLookup ?? anchor.dataset.wikiPath ?? anchor.getAttribute("href") ?? "";
          if (wikiLookup === undefined && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(path)) {
            return;
          }
          event.preventDefault();
          if (options.busy) {
            return;
          }
          let logicalPath: string;
          let heading: string;
          try {
            if (wikiLookup !== undefined) {
              const separator = path.indexOf("#");
              logicalPath = decodeVaultLinkTarget(
                separator < 0 ? path : path.slice(0, separator),
              ).replace(/^\/+/, "/");
              heading = separator < 0 ? "" : decodeVaultLinkTarget(path.slice(separator + 1));
            } else {
              const sourcePath = document.logicalPath.split("/").map(encodeURIComponent).join("/");
              const url = new URL(path, `https://vault.invalid/${sourcePath}`);
              logicalPath = decodeVaultLinkTarget(url.pathname.slice(path.startsWith("/") ? 0 : 1));
              heading = decodeVaultLinkTarget(url.hash.slice(1));
            }
          } catch {
            options.onUnresolvedLink();
            return;
          }
          if (!logicalPath || logicalPath.replace(/^\/+/, "") === document.logicalPath) {
            options.onOpen(document.id, heading);
            return;
          }
          // Resolution, ambiguity and access belong to the server. Match the
          // original parsed target, not a label or the resolved document path.
          const matches = document.links.filter((candidate) => candidate.target === logicalPath);
          const ids = new Set(matches.map((candidate) => candidate.documentId));
          const id = ids.size === 1 ? ids.values().next().value : null;
          if (id) {
            options.onOpen(id, heading);
          } else {
            options.onUnresolvedLink();
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
      ${!options.linkNotice && document.links.some((link) => !link.documentId)
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
  selection?: { ids: ReadonlySet<string>; onChange: (id: string, checked: boolean) => void };
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
              actions: options.selection
                ? html`<label class="vaults__document-select">
                    <input
                      type="checkbox"
                      data-document-select=${document.id}
                      aria-label=${platformClawT("platformClaw.vault.selectDocument", {
                        title: document.title,
                      })}
                      .checked=${options.selection.ids.has(document.id)}
                      ?disabled=${options.busy}
                      @change=${(event: Event) =>
                        options.selection!.onChange(
                          document.id,
                          (event.target as HTMLInputElement).checked,
                        )}
                    />
                    ${t("selectDocumentLabel")}
                  </label>`
                : nothing,
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
