import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { MemorySearchResponse } from "../../../../src/gateway/server-methods/memory-search.ts";
import { icons } from "../../components/icons.ts";
import {
  compactKnowledgeRevision,
  renderKnowledgeDocumentCard,
} from "../../components/knowledge-document-card.ts";
import { renderKnowledgeDocumentReader } from "../../components/knowledge-document-reader.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { renderMemoryItemActions } from "../../components/memory-item-actions.ts";
import { renderSettingsRow, renderSettingsSegmented } from "../../components/settings-ui.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import "../../styles/sidebar-markdown.css";

export type Translate = (key: string, params?: Record<string, string>) => string;
type BrowseEntry = {
  path: string;
  name: string;
  updatedAtMs?: number;
};
export type BrowseListResult = {
  entries: BrowseEntry[];
  hasAdditionalFolders?: boolean;
  truncated?: boolean;
};
export type BrowserWorkspaceGetResult = {
  file: {
    path: string;
    name: string;
    encoding: "utf8";
    content: string;
    missing?: boolean;
    updatedAtMs?: number;
  };
};
export type BrowseState =
  | { kind: "idle" | "loading" }
  | {
      kind: "ready";
      memory: BrowserWorkspaceGetResult["file"] | null;
      recent: BrowseEntry[];
      memoryError: string | null;
      recentError: string | null;
      additionalEntries: boolean;
    };
export type WikiSearchResult = {
  path: string;
  title: string;
  kind: string;
  score: number;
  snippet: string;
  startLine?: number;
  endLine?: number;
};
export type WikiGetResult = {
  content?: string;
  displayContent?: string;
  fromLine?: number;
  lineCount?: number;
};
export type MemoryResultActions = {
  label: string;
  available: (result: SearchResult) => boolean;
  open: (result: SearchResult, event: Event) => void;
};

function resultActions(result: SearchResult, actions?: MemoryResultActions) {
  return actions?.available(result)
    ? {
        label: actions.label,
        open: (_lookup: string, event: Event) => actions.open(result, event),
      }
    : undefined;
}
export type SearchResult = Omit<MemorySearchResponse["results"][number], "source"> & {
  source: string;
  title?: string;
  kind?: string;
  provenanceLabel?: string;
  vaultId?: string;
  vaultName?: string;
  vaultType?: "personal" | "shared";
  documentId?: string;
  revision?: string | number;
  indexStatus?: "failed";
  indexError?: string;
  nextRetryAt?: number;
};
export type BrowserMemorySearchResponse = Omit<MemorySearchResponse, "results"> & {
  results: SearchResult[];
  sharedVaultUnavailable?: boolean;
  personalWikiUnavailable?: boolean;
  personalMemoryUnavailable?: boolean;
  personalMemoryMethodUnavailable?: boolean;
  personalWikiMethodUnavailable?: boolean;
};
export type SearchState =
  | { kind: "idle" }
  | { kind: "loading"; query: string }
  | ({ kind: "ready"; query: string } & BrowserMemorySearchResponse)
  | { kind: "error"; query: string; message: string };
export type MemorySourceFilter = "all" | "memory" | "wiki" | "shared" | "sessions";
export type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "error"; message: string };

export function renderMemorySearchForm(options: {
  text: Translate;
  query: string;
  placeholder: string | null;
  disabled: boolean;
  onSubmit: () => void;
  onInput: (value: string) => void;
}) {
  return html`<form
    class="memory-memories__search"
    role="search"
    @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      options.onSubmit();
    }}
  >
    <label class="settings-control__sr-label" for="memory-search-input"
      >${options.placeholder ?? options.text("memoryPage.memories.searchLabel")}</label
    >
    <input
      id="memory-search-input"
      type="search"
      class="settings-input"
      .value=${options.query}
      placeholder=${options.placeholder ?? options.text("memoryPage.memories.searchPlaceholder")}
      @input=${(event: InputEvent) =>
        options.onInput((event.currentTarget as HTMLInputElement).value)}
    />
    <button class="btn btn--sm primary" type="submit" ?disabled=${options.disabled}>
      ${options.text("memoryPage.memories.searchButton")}
    </button>
  </form>`;
}

export function renderMemoryConnectionStatus(options: {
  browseEnabled: boolean;
  connected: boolean;
  browseReady: boolean;
  label: string;
}) {
  return options.browseEnabled && !options.connected && options.browseReady
    ? html`<div class="settings-empty" role="status">${options.label}</div>`
    : nothing;
}

export function resultKey(result: SearchResult, index: number): string {
  return `${index}:${result.path}:${result.startLine}:${result.endLine}`;
}

export function isExpandableResult(result: SearchResult): boolean {
  if (result.vaultType === "shared") {
    return Boolean(result.vaultId && result.documentId);
  }
  const normalizedPath = result.path.replaceAll("\\", "/");
  const safeRelativePath =
    !normalizedPath.startsWith("/") &&
    !normalizedPath.startsWith("sessions/") &&
    !/^[a-zA-Z]:\//.test(normalizedPath) &&
    normalizedPath.split("/").every((segment) => segment && segment !== "." && segment !== "..");
  const workspaceMemoryPath =
    normalizedPath === "MEMORY.md" || normalizedPath.startsWith("memory/");
  // workspace.get is workspace-contained; sessions/* and qmd/* are logical manager paths.
  if (result.source === "wiki") {
    return safeRelativePath && result.path.endsWith(".md");
  }
  return result.source === "memory" && safeRelativePath && workspaceMemoryPath;
}

function renderFileContent(content: string, result?: SearchResult) {
  const lines = content.split(/\r?\n/);
  const start = result ? Math.max(0, result.startLine - 1) : 0;
  const end = result ? Math.min(lines.length, result.endLine) : 0;
  return html`${result
      ? html`<div class="memory-memories__match-context">
          <mark data-memory-match="true">${lines.slice(start, end).join("\n")}</mark>
        </div>`
      : nothing}
    <article class="sidebar-markdown wiki-document__reader">
      ${unsafeHTML(
        toSanitizedMarkdownHtml(content, {
          codeBlockChrome: "none",
          fileLinks: false,
          interactiveImages: false,
        }),
      )}
    </article>`;
}

type DetailView = {
  details: ReadonlyMap<string, DetailState>;
  key: string;
  openResultKey: string | null;
  panelId: string;
  result: SearchResult;
  text: Translate;
  onRetry: (key: string, result: SearchResult) => void;
  onClose?: () => void;
};

function renderDetail(view: DetailView) {
  if (view.openResultKey !== view.key) {
    return nothing;
  }
  const detail = view.details.get(view.key);
  const content = html`<div id=${view.panelId} class="memory-memories__detail">
    ${!detail || detail.kind === "loading"
      ? html`<p role="status">${view.text("memoryPage.memories.fileLoading")}</p>`
      : detail.kind === "error"
        ? html`<div class="memory-memories__detail-error" role="alert">
            <p>${view.text("memoryPage.memories.fileError", { message: detail.message })}</p>
            <button class="btn btn--sm" @click=${() => view.onRetry(view.key, view.result)}>
              ${view.text("memoryPage.memories.retry")}
            </button>
          </div>`
        : renderFileContent(detail.content, view.result.startLine > 0 ? view.result : undefined)}
  </div>`;
  return view.onClose
    ? renderKnowledgeDocumentReader({
        title: view.result.title ?? view.result.path,
        metadata: view.result.vaultName ?? view.result.path,
        content,
        closeLabel: view.text("platformClaw.vault.close"),
        onClose: view.onClose,
      })
    : content;
}

export function renderMemoryBrowseFile(options: {
  actions?: MemoryResultActions;
  canLoadResult: (result: SearchResult) => boolean;
  content?: string;
  description?: string;
  details: ReadonlyMap<string, DetailState>;
  index: number;
  name: string;
  onRetry: (key: string, result: SearchResult) => void;
  onToggle: (result: SearchResult, index: number, content?: string) => void;
  openResultKey: string | null;
  path: string;
  text: Translate;
  updatedAtMs?: number;
  onClose?: () => void;
}) {
  const result: SearchResult = {
    path: options.path,
    startLine: 0,
    endLine: 0,
    score: 0,
    snippet: options.name,
    source: "memory",
  };
  const key = resultKey(result, options.index);
  const cached = options.content !== undefined || options.details.get(key)?.kind === "ready";
  const modified = formatDateTimeMs(options.updatedAtMs, undefined, "");
  const description = [
    options.description,
    modified ? options.text("memoryPage.memories.lastModified", { date: modified }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (!cached && !options.canLoadResult(result)) {
    return renderSettingsRow({ title: options.name, description });
  }
  const panelId =
    options.index === -1 ? "memory-long-term-detail" : `memory-browse-detail-${-options.index}`;
  const actions = resultActions(result, options.actions);
  return html`<article
    class="memory-memories__result memory-memories__result--browse"
    @contextmenu=${actions ? (event: MouseEvent) => actions.open(result.path, event) : nothing}
  >
    <button
      type="button"
      class="settings-row settings-row--nav"
      aria-expanded=${String(options.openResultKey === key)}
      aria-controls=${panelId}
      @click=${() => options.onToggle(result, options.index, options.content)}
    >
      <span class="settings-row__text">
        <span class="settings-row__title">${options.name}</span>
        ${description ? html`<span class="settings-row__desc">${description}</span>` : nothing}
      </span>
      <span class="settings-row__control">
        <span class="settings-row__chevron" aria-hidden="true"
          >${options.openResultKey === key ? icons.chevronDown : icons.chevronRight}</span
        >
      </span>
    </button>
    ${renderMemoryItemActions(result.path, actions)}
    ${renderDetail({
      details: options.details,
      key,
      openResultKey: options.openResultKey,
      panelId,
      result,
      text: options.text,
      onRetry: options.onRetry,
      onClose: options.onClose,
    })}
  </article>`;
}

export function renderMemorySearchState(options: {
  actions?: MemoryResultActions;
  canLoadResult: (result: SearchResult) => boolean;
  vaultDocumentDialog?: boolean;
  onClose?: () => void;
  details: ReadonlyMap<string, DetailState>;
  onRetry: (key: string, result: SearchResult) => void;
  onSearch: (query: string) => void;
  onSourceFilterChange: (source: MemorySourceFilter) => void;
  onToggle: (result: SearchResult, index: number) => void;
  openResultKey: string | null;
  searchState: SearchState;
  sourceFilter: MemorySourceFilter;
  text: Translate;
}) {
  switch (options.searchState.kind) {
    case "loading":
      return html`<p class="memory-memories__state" role="status">
        ${options.text("memoryPage.memories.searching")}
      </p>`;
    case "error": {
      const failed = options.searchState;
      return html`<div class="memory-memories__state" role="alert">
        <p>${options.text("memoryPage.memories.error", { message: failed.message })}</p>
        <button class="btn btn--sm" @click=${() => options.onSearch(failed.query)}>
          ${options.text("memoryPage.memories.retry")}
        </button>
      </div>`;
    }
    case "ready":
      return renderMemorySearchResults({
        actions: options.actions,
        ready: options.searchState,
        sourceFilter: options.sourceFilter,
        onSourceFilterChange: options.onSourceFilterChange,
        details: options.details,
        openResultKey: options.openResultKey,
        text: options.text,
        canLoadResult: options.canLoadResult,
        vaultDocumentDialog: options.vaultDocumentDialog,
        onClose: options.onClose,
        onToggle: options.onToggle,
        onRetry: options.onRetry,
      });
    default:
      return nothing;
  }
}

function renderMemorySearchResults(options: {
  actions?: MemoryResultActions;
  canLoadResult: (result: SearchResult) => boolean;
  vaultDocumentDialog?: boolean;
  onClose?: () => void;
  details: ReadonlyMap<string, DetailState>;
  onRetry: (key: string, result: SearchResult) => void;
  onToggle: (result: SearchResult, index: number) => void;
  openResultKey: string | null;
  ready: Extract<SearchState, { kind: "ready" }>;
  text: Translate;
  sourceFilter: MemorySourceFilter;
  onSourceFilterChange: (source: MemorySourceFilter) => void;
}) {
  const { ready, text } = options;
  // Filter after recording original positions: detail caches and async requests
  // belong to the full result set, not the index within a filtered view.
  const visible = ready.results
    .map((result, index) => ({ result, index }))
    .filter(
      ({ result }) => options.sourceFilter === "all" || result.source === options.sourceFilter,
    );
  const mode =
    ready.searchMode === "hybrid"
      ? text("memoryPage.memories.hybridSearch")
      : text("memoryPage.memories.keywordSearch");
  const resultCount = text("memoryPage.memories.results", {
    count: String(visible.length),
  });
  const sourceNotices = [
    ready.sharedVaultUnavailable ? text("platformClaw.vault.searchUnavailable") : null,
    ready.personalMemoryUnavailable
      ? text("memoryPage.memories.personalUnavailable")
      : ready.personalMemoryMethodUnavailable
        ? text("memoryPage.memories.personalMethodUnavailable")
        : null,
    ready.personalWikiUnavailable
      ? text("memoryPage.memories.wikiUnavailable")
      : ready.personalWikiMethodUnavailable
        ? text("memoryPage.memories.wikiMethodUnavailable")
        : null,
  ].filter((message): message is string => message !== null);
  const liveSummary = [
    resultCount,
    mode,
    ...(ready.stale ? [text("memoryPage.memories.staleResults")] : []),
    ...sourceNotices,
  ].join(" ");
  return html`
    ${ready.results.length > 0
      ? html` <div class="memory-memories__filters">
          ${renderSettingsSegmented<MemorySourceFilter>({
            value: options.sourceFilter,
            ariaLabel: text("memoryPage.memories.sourceFilter"),
            onChange: options.onSourceFilterChange,
            options: (
              [
                ["all", text("memoryPage.memories.sourceAll")],
                ["memory", text("memoryPage.memories.sourceMemory")],
                ["wiki", text("memoryPage.memories.sourceWiki")],
                ["shared", text("platformClaw.vault.shared")],
                ["sessions", text("memoryPage.memories.sourceSessions")],
              ] as const
            ).flatMap(([value, label]) => {
              const count =
                value === "all"
                  ? ready.results.length
                  : ready.results.filter((item) => item.source === value).length;
              return count > 0
                ? [{ value, label: html`${label} <span class="settings-count">${count}</span>` }]
                : [];
            }),
          })}
          <span class="settings-row__desc">${text("memoryPage.memories.sourceFilterHint")}</span>
        </div>`
      : nothing}
    <div
      class="memory-memories__results-heading"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label=${liveSummary}
    >
      <span>${resultCount}</span>
      <span class="memory-memories__mode">${mode}</span>
    </div>
    ${ready.stale
      ? html`<p class="memory-memories__state">${text("memoryPage.memories.staleResults")}</p>`
      : nothing}
    ${sourceNotices.length > 0
      ? html`<p class="memory-memories__state">${sourceNotices.join(" ")}</p>`
      : nothing}
    ${ready.results.length === 0
      ? html`<p class="memory-memories__state">
          ${text("memoryPage.memories.empty", { query: ready.query })}
        </p>`
      : html`<div class="settings-group memory-memories__results">
          ${visible.map(({ result, index }) => {
            const key = resultKey(result, index);
            const open = options.openResultKey === key;
            const expandable =
              options.details.get(key)?.kind === "ready" || options.canLoadResult(result);
            const panelId = `memory-detail-${index}`;
            const path = html`<span class="settings-row__desc memory-memories__path"
              >${result.path} ·
              ${text("memoryPage.memories.lineRange", {
                start: String(result.startLine),
                end: String(result.endLine),
              })}</span
            >`;
            const metadata = result.vaultId
              ? html`<span class="settings-row__desc" data-vault-provenance
                  >${result.vaultName} ·
                  ${text(
                    result.vaultType === "shared"
                      ? "platformClaw.vault.shared"
                      : "platformClaw.vault.typePersonal",
                  )}
                  ·
                  ${text("memoryPage.memories.revision", {
                    revision: compactKnowledgeRevision(result.revision ?? ""),
                  })}</span
                >`
              : html`${path}<span
                    class="memory-memories__source"
                    title=${text("memoryPage.memories.score", { score: result.score.toFixed(2) })}
                    >${result.source === "wiki"
                      ? text("memoryPage.memories.sourceWiki")
                      : result.source === "sessions"
                        ? text("memoryPage.memories.sourceSessions")
                        : text("memoryPage.memories.sourceMemory")}</span
                  >`;
            const status =
              result.indexStatus === "failed"
                ? html`<span class="settings-row__desc" data-memory-index-warning role="status"
                    >${text("platformClaw.vault.retainedIndex")}
                    ${result.indexError ?? ""}${result.nextRetryAt
                      ? html`${text("platformClaw.vault.retryAt")}:
                        ${formatDateTimeMs(result.nextRetryAt)}`
                      : nothing}</span
                  >`
                : nothing;
            const actions = resultActions(result, options.actions);
            return renderKnowledgeDocumentCard({
              title: result.title ?? result.snippet,
              metadata,
              snippet: result.title ? result.snippet : undefined,
              status,
              source: result.source,
              modal:
                Boolean(options.onClose) ||
                (options.vaultDocumentDialog &&
                  (result.vaultType === "shared" || result.source === "wiki")),
              expanded: open,
              panelId,
              onOpen: expandable ? () => options.onToggle(result, index) : undefined,
              onContextMenu: actions ? (event) => actions.open(result.path, event) : undefined,
              actions: renderMemoryItemActions(result.path, actions),
              details: html`${result.vaultId
                ? html`<details class="memory-memories__provenance-details">
                    <summary>${text("platformClaw.vault.documentDetails")}</summary>
                    <span class="settings-row__desc memory-memories__path"
                      >${result.vaultId} · ${result.documentId}</span
                    >${path}
                    <span class="settings-row__desc"
                      >${text("memoryPage.memories.revision", {
                        revision: String(result.revision),
                      })}</span
                    >
                  </details>`
                : nothing}${expandable
                ? renderDetail({
                    details: options.details,
                    key,
                    openResultKey: options.openResultKey,
                    panelId,
                    result,
                    text,
                    onRetry: options.onRetry,
                    onClose: options.onClose,
                  })
                : nothing}`,
            });
          })}
        </div>`}
  `;
}
