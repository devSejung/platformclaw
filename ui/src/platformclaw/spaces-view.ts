import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type {
  Space,
  SpaceMember,
  SpacePage,
} from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import type { SpaceMessage } from "../../../packages/platformclaw-control-plane/src/space-service.js";
import { icons } from "../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { platformClawT } from "./i18n.ts";
const t = (key: string) => platformClawT(`platformClaw.spaces.${key}`);
export type SpaceSnapshot = { space: Space; pages: SpacePage[]; members: SpaceMember[] };
export type SpaceSearchHit = {
  spaceId: string;
  pageId: string;
  pageTitle: string;
  snippet: string;
  link: string;
  messageId?: string;
};
type SpaceEditor = { kind: "space" | "page" | "edit"; title: string; body: string };
type SpacesViewProps = {
  spaces: Space[];
  snapshot: SpaceSnapshot | null;
  page: SpacePage | null;
  messages: SpaceMessage[];
  error: string;
  notice: string;
  streaming: string;
  historyAnchor: string;
  loading: boolean;
  busy: boolean;
  editor: SpaceEditor | null;
  panel: "notes" | "members" | null;
  navigationOpen: boolean;
  draft: string;
  query: string;
  hits: SpaceSearchHit[];
  membersView: TemplateResult | typeof nothing;
  onSelectSpace: (id: string) => void;
  onSelectPage: (page: SpacePage, messageId?: string) => void;
  onCreate: (kind: "space" | "page", parentId?: string) => void;
  onRefresh: () => void;
  onSearch: () => void;
  onQuery: (value: string) => void;
  onDraft: (value: string) => void;
  onSend: () => void;
  onPanel: (panel: "notes" | "members") => void;
  onClosePanel: () => void;
  onToggleNavigation: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onHistoryScroll: (event: Event) => void;
  onSave: () => void;
  onTitle: (value: string) => void;
  onBody: (value: string) => void;
  onLatest: () => void;
};

function renderPageTree(
  p: SpacesViewProps,
  parentId: string | null = null,
  depth = 0,
): TemplateResult {
  return html`<ul class="pc-space-tree">
    ${p.snapshot?.pages
      .filter((page) => page.parentId === parentId)
      .map(
        (page) => html` <li>
          <button
            class="pc-space-tree-item"
            aria-current=${p.page?.id === page.id ? "page" : nothing}
            ?disabled=${p.busy || Boolean(p.editor)}
            @click=${() => p.onSelectPage(page)}
            title=${page.title}
          >
            ${icons.messageSquare}<span>${page.title}</span></button
          >${depth < 20 ? renderPageTree(p, page.id, depth + 1) : nothing}
        </li>`,
      )}
  </ul>`;
}

function renderSidebar(p: SpacesViewProps) {
  return html`<aside class="pc-spaces-sidebar" id="pc-spaces-navigation" aria-label=${t("pages")}>
    <div class="pc-spaces-sidebar-heading">
      <h2>${t("title")}</h2>
      <button
        class="pc-space-icon-button pc-space-mobile-only"
        aria-label=${t("closeNavigation")}
        @click=${p.onToggleNavigation}
      >
        ${icons.x}
      </button>
    </div>
    <button
      class="pc-space-new"
      data-new-page
      ?disabled=${p.busy || Boolean(p.editor) || !p.snapshot || p.snapshot.space.role === "viewer"}
      @click=${() => p.onCreate("page")}
    >
      ${icons.plus}<span>${t("createPage")}</span>
    </button>
    ${p.snapshot
      ? html`<form
          class="pc-space-search"
          @submit=${(event: Event) => {
            event.preventDefault();
            p.onSearch();
          }}
        >
          <label class="pc-space-sr-only" for="pc-spaces-search">${t("search")}</label>
          <input
            id="pc-spaces-search"
            type="search"
            .value=${p.query}
            placeholder=${t("search")}
            @input=${(event: Event) => p.onQuery((event.target as HTMLInputElement).value)}
          />
          <button
            class="pc-space-icon-button"
            aria-label=${t("search")}
            ?disabled=${p.busy}
            title=${t("search")}
          >
            ${icons.search}
          </button>
        </form>`
      : nothing}
    <div class="pc-spaces-sidebar-scroll">
      ${p.hits.length
        ? html`<section class="pc-space-results" aria-label=${t("searchResults")}>
            <h3>${t("searchResults")}</h3>
            ${p.hits.map(
              (hit) => html`<button
                @click=${() => {
                  const page = p.snapshot?.pages.find((item) => item.id === hit.pageId);
                  if (page) {
                    p.onSelectPage(page, hit.messageId);
                  }
                }}
              >
                <strong>${hit.pageTitle}</strong><span>${hit.snippet}</span>
              </button>`,
            )}
          </section>`
        : nothing}
      <nav aria-label=${t("title")}>
        ${p.spaces.map(
          (space) => html`<div class="pc-space-group">
            <button
              class="pc-space-group-title"
              ?disabled=${p.busy || Boolean(p.editor)}
              aria-current=${p.snapshot?.space.id === space.id ? "true" : nothing}
              @click=${() => p.onSelectSpace(space.id)}
              title=${space.name}
            >
              ${icons.folder}<span>${space.name}</span> ${p.snapshot?.space.id === space.id
                ? html`<span class="pc-space-count">${p.snapshot.pages.length}</span>`
                : nothing}</button
            >${p.snapshot?.space.id === space.id ? renderPageTree(p) : nothing}
          </div>`,
        )}
      </nav>
    </div>
    <div class="pc-spaces-sidebar-footer">
      <button
        class="pc-space-text-button"
        ?disabled=${p.busy || Boolean(p.editor)}
        @click=${() => p.onCreate("space")}
      >
        ${icons.plus}${t("createSpace")}
      </button>
      <button
        class="pc-space-icon-button"
        ?disabled=${p.busy || p.loading}
        @click=${p.onRefresh}
        aria-label=${t("refresh")}
        title=${t("refresh")}
      >
        ${icons.refresh}
      </button>
    </div>
  </aside>`;
}

function renderMessage(message: SpaceMessage, anchor: string) {
  const assistant = message.role === "assistant";
  // Pre-wrap must preserve authored line breaks, not the template indentation.
  return html`<article
    class="pc-space-message ${assistant ? "pc-space-message--assistant" : "pc-space-message--user"}"
    id=${`message-${message.id}`}
    data-source=${anchor === message.id ? "true" : nothing}
  >
    <div class="pc-space-message-meta">
      <strong>${assistant ? "AI" : (message.authorName ?? t("unknownAuthor"))}</strong>
      ${message.timestamp
        ? html`<time title=${new Date(message.timestamp).toLocaleString()}
            >${new Date(message.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}</time
          >`
        : nothing}
    </div>
    ${assistant
      ? html`<div class="pc-space-message-body markdown-content">
          ${unsafeHTML(toSanitizedMarkdownHtml(message.text, { codeBlockChrome: "none" }))}
        </div>`
      : html`<div class="pc-space-message-body pc-space-text" .textContent=${message.text}></div>`}
  </article>`;
}

function renderConversation(p: SpacesViewProps) {
  const canEdit = p.snapshot && p.snapshot.space.role !== "viewer";
  return html`<section class="pc-space-conversation" aria-label=${t("conversation")}>
    <div
      class="pc-space-history"
      tabindex="0"
      aria-label=${t("conversation")}
      @scroll=${p.onHistoryScroll}
    >
      <div class="pc-space-message-column">
        ${p.historyAnchor
          ? html`<button class="pc-space-source-link" @click=${p.onLatest}>
              ${icons.arrowDown}${t("latest")}
            </button>`
          : nothing}
        ${p.messages.length || p.streaming
          ? p.messages.map((message) => renderMessage(message, p.historyAnchor))
          : html` <div class="pc-space-conversation-empty">
              <span class="pc-space-empty-icon">${icons.messageSquare}</span>
              <h2>${t("startConversation")}</h2>
              <p>${t("conversationHint")}</p>
            </div>`}
        ${p.streaming
          ? html`<article class="pc-space-message pc-space-message--assistant" aria-live="polite">
              <div class="pc-space-message-meta">
                <strong>AI</strong><span class="pc-space-live-dot"></span>
              </div>
              <div class="pc-space-message-body markdown-content">
                ${unsafeHTML(toSanitizedMarkdownHtml(p.streaming, { codeBlockChrome: "none" }))}
              </div>
            </article>`
          : nothing}
      </div>
    </div>
    <div class="pc-space-composer-dock">
      ${canEdit
        ? html`<form
            class="pc-space-composer"
            @submit=${(event: Event) => {
              event.preventDefault();
              p.onSend();
            }}
          >
            <label class="pc-space-sr-only" for="pc-space-draft">${t("ask")}</label>
            <textarea
              id="pc-space-draft"
              rows="2"
              maxlength="16000"
              .value=${p.draft}
              placeholder=${t("ask")}
              @input=${(event: Event) => p.onDraft((event.target as HTMLTextAreaElement).value)}
              @keydown=${(event: KeyboardEvent) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.isComposing &&
                  p.draft.trim() &&
                  !p.busy
                ) {
                  event.preventDefault();
                  p.onSend();
                }
              }}
            ></textarea>
            <div class="pc-space-composer-bottom">
              <span>${icons.users}${t("sharedConversation")}</span>
              <button
                class="pc-space-send"
                aria-label=${t("send")}
                title=${t("send")}
                ?disabled=${p.busy || !p.draft.trim()}
              >
                ${icons.arrowUp}<span class="pc-space-sr-only">${t("send")}</span>
              </button>
            </div>
          </form>`
        : html`<p class="pc-space-viewer-notice">${icons.lock}${t("viewerNotice")}</p>`}
      <p class="pc-space-sharing-hint">${t("sharedNotice")}</p>
    </div>
  </section>`;
}

function renderEditor(p: SpacesViewProps) {
  const editor = p.editor!;
  return html`<form
    class="pc-space-editor"
    @submit=${(event: Event) => {
      event.preventDefault();
      p.onSave();
    }}
  >
    <p class="pc-space-panel-hint">${editor.kind === "space" ? t("spaceHint") : t("notesHint")}</p>
    <label
      >${t("name")}<input
        data-title
        required
        maxlength="160"
        .value=${editor.title}
        @input=${(event: Event) => p.onTitle((event.target as HTMLInputElement).value)}
    /></label>
    ${editor.kind !== "space"
      ? html`<label class="pc-space-editor-body"
          >${t("body")}<textarea
            rows="12"
            maxlength="32000"
            .value=${editor.body}
            @input=${(event: Event) => p.onBody((event.target as HTMLTextAreaElement).value)}
          ></textarea>
        </label>`
      : nothing}
    <div class="pc-space-editor-actions">
      <button type="button" class="btn" ?disabled=${p.busy} @click=${p.onCancel}>
        ${t("cancel")}</button
      ><button class="btn primary" ?disabled=${p.busy}>${t("save")}</button>
    </div>
  </form>`;
}

function renderPanel(p: SpacesViewProps) {
  const title = p.editor
    ? t(
        p.editor.kind === "space"
          ? "createSpace"
          : p.editor.kind === "page"
            ? "createPage"
            : "edit",
      )
    : t(p.panel === "members" ? "members" : "notes");
  return html`<aside class="pc-space-panel" aria-label=${title}>
    <div class="pc-space-panel-header">
      <h2>${title}</h2>
      <button
        class="pc-space-icon-button"
        aria-label=${t("closePanel")}
        title=${t("closePanel")}
        ?disabled=${p.busy}
        @click=${p.onClosePanel}
      >
        ${icons.x}
      </button>
    </div>
    <div class="pc-space-panel-content">
      ${p.editor
        ? renderEditor(p)
        : p.panel === "members"
          ? p.membersView
          : p.page
            ? html` <div class="pc-space-notes">
                <h3>${p.page.title}</h3>
                <p class="pc-space-note-meta">
                  ${t("revision")} ${p.page.revision} ·
                  ${new Date(p.page.updatedAt).toLocaleDateString()}
                </p>
                <div class="markdown-content">
                  ${p.page.body
                    ? unsafeHTML(toSanitizedMarkdownHtml(p.page.body, { codeBlockChrome: "none" }))
                    : html`<p class="pc-space-panel-hint">${t("emptyNotes")}</p>`}
                </div>
                ${p.snapshot?.space.role !== "viewer"
                  ? html`<div class="pc-space-note-actions">
                      <button class="btn" @click=${p.onEdit}>${icons.penLine}${t("edit")}</button>
                      <button
                        class="pc-space-text-button"
                        ?disabled=${p.busy}
                        @click=${() => p.onCreate("page", p.page!.id)}
                      >
                        ${icons.plus}${t("createChild")}
                      </button>
                    </div>`
                  : nothing}
              </div>`
            : nothing}
    </div>
  </aside>`;
}

export function renderSpacesView(p: SpacesViewProps) {
  const hasPanel = Boolean(p.editor || p.panel);
  const canEdit = p.snapshot && p.snapshot.space.role !== "viewer";
  return html`<main
    class="pc-spaces ${p.navigationOpen ? "pc-spaces--navigation" : ""} ${hasPanel
      ? "pc-spaces--panel"
      : ""}"
    @keydown=${(event: KeyboardEvent) => {
      if (event.key === "Escape" && !p.busy) {
        if (hasPanel) {
          p.onClosePanel();
        } else if (p.navigationOpen) {
          p.onToggleNavigation();
        }
      }
    }}
  >
    ${renderSidebar(p)}
    <div class="pc-spaces-center">
      <header class="pc-spaces-topbar">
        <button
          class="pc-space-icon-button pc-space-mobile-only"
          aria-label=${t("openNavigation")}
          aria-controls="pc-spaces-navigation"
          aria-expanded=${p.navigationOpen}
          @click=${p.onToggleNavigation}
        >
          ${icons.menu}
        </button>
        <div class="pc-space-heading">
          <span>${p.snapshot?.space.name ?? t("title")}</span>
          <h1>${p.page?.title ?? t("title")}</h1>
        </div>
        <div class="pc-space-topbar-actions">
          ${p.page
            ? html`<button
                class="pc-space-text-button pc-space-notes-trigger"
                aria-label=${t("notes")}
                aria-pressed=${p.panel === "notes"}
                ?disabled=${Boolean(p.editor)}
                @click=${() => p.onPanel("notes")}
              >
                ${icons.fileText}<span>${t("notes")}</span>
              </button>`
            : nothing}
          ${p.snapshot
            ? html`<button
                class="pc-space-text-button pc-space-members-trigger"
                aria-label=${t("members")}
                aria-pressed=${p.panel === "members"}
                ?disabled=${Boolean(p.editor)}
                @click=${() => p.onPanel("members")}
              >
                ${icons.users}<span>${p.snapshot.members.length}</span>
              </button>`
            : nothing}
        </div>
      </header>
      <div class="pc-space-feedback">
        ${p.error
          ? html`<p class="pc-space-error" role="alert">
              ${p.error}<button
                class="pc-space-text-button"
                ?disabled=${p.busy}
                @click=${p.onRefresh}
              >
                ${t("refresh")}
              </button>
            </p>`
          : nothing}
        ${p.notice
          ? html`<p class="pc-space-notice" role="status">${p.notice}</p>`
          : nothing}${p.loading
          ? html`<p class="pc-space-notice" role="status">${t("loading")}</p>`
          : nothing}
      </div>
      ${p.page
        ? renderConversation(p)
        : html`<section class="pc-space-welcome">
            <span class="pc-space-empty-icon">${icons.messageSquare}</span>
            <h2>${p.snapshot ? p.snapshot.space.name : t("title")}</h2>
            <p>${p.snapshot ? t("choosePage") : t("chooseSpace")}</p>
            ${canEdit
              ? html`<button
                  class="btn primary"
                  ?disabled=${p.busy || Boolean(p.editor)}
                  @click=${() => p.onCreate("page")}
                >
                  ${icons.plus}${t("startIssue")}
                </button>`
              : !p.snapshot
                ? html`<button
                    class="btn primary"
                    ?disabled=${p.busy || Boolean(p.editor)}
                    @click=${() => p.onCreate("space")}
                  >
                    ${icons.plus}${t("startSpace")}
                  </button>`
                : nothing}
            <span class="pc-space-privacy-hint">${t("intro")}</span>
          </section>`}
    </div>
    ${hasPanel ? renderPanel(p) : nothing}
  </main>`;
}
