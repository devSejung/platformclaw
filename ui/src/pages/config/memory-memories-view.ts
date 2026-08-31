import { html, nothing } from "lit";
import type { MemorySearchResponse } from "../../../../src/gateway/server-methods/memory-search.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsRow } from "../../components/settings-ui.ts";

export type Translate = (key: string, params?: Record<string, string>) => string;
export type SearchResult = Omit<MemorySearchResponse["results"][number], "source"> & {
  source: string;
  title?: string;
  kind?: string;
  provenanceLabel?: string;
};
export type BrowserMemorySearchResponse = Omit<MemorySearchResponse, "results"> & {
  results: SearchResult[];
  organizationMemoryUnavailable?: boolean;
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
export type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "error"; message: string };

export function resultKey(result: SearchResult, index: number): string {
  return `${index}:${result.path}:${result.startLine}:${result.endLine}`;
}

export function isExpandableResult(result: SearchResult): boolean {
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
  if (result.source === "organization") {
    return /^organization\/(global|team|group|part)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(
      normalizedPath,
    );
  }
  return result.source === "memory" && safeRelativePath && workspaceMemoryPath;
}

function renderFileContent(content: string, result?: SearchResult) {
  if (!result) {
    return html`<pre class="memory-memories__file" tabindex="0">${content}</pre>`;
  }
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, result.startLine - 1);
  const end = Math.min(lines.length, result.endLine);
  const before = lines.slice(0, start);
  const matched = lines.slice(start, end);
  const after = lines.slice(end);
  return html`<pre class="memory-memories__file" tabindex="0"><span
      >${before.join("\n")}${before.length ? "\n" : ""}</span
    ><mark data-memory-match="true">${matched.join("\n")}</mark
    ><span>${after.length ? `\n${after.join("\n")}` : ""}</span></pre>`;
}

type DetailView = {
  details: ReadonlyMap<string, DetailState>;
  key: string;
  openResultKey: string | null;
  panelId: string;
  result: SearchResult;
  text: Translate;
  onRetry: (key: string, result: SearchResult) => void;
};

function renderDetail(view: DetailView) {
  if (view.openResultKey !== view.key) {
    return nothing;
  }
  const detail = view.details.get(view.key);
  return html`<div id=${view.panelId} class="memory-memories__detail">
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
}

export function renderMemoryBrowseFile(options: {
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
  if (!cached && !options.canLoadResult(result)) {
    return renderSettingsRow({ title: options.name, description: options.description });
  }
  const panelId =
    options.index === -1 ? "memory-long-term-detail" : `memory-browse-detail-${-options.index}`;
  return html`<article class="memory-memories__result">
    <button
      type="button"
      class="settings-row settings-row--nav"
      aria-expanded=${String(options.openResultKey === key)}
      aria-controls=${panelId}
      @click=${() => options.onToggle(result, options.index, options.content)}
    >
      <span class="settings-row__text">
        <span class="settings-row__title">${options.name}</span>
        ${options.description === undefined
          ? nothing
          : html`<span class="settings-row__desc">${options.description}</span>`}
      </span>
      <span class="settings-row__control">
        <span class="settings-row__chevron" aria-hidden="true"
          >${options.openResultKey === key ? icons.chevronDown : icons.chevronRight}</span
        >
      </span>
    </button>
    ${renderDetail({
      details: options.details,
      key,
      openResultKey: options.openResultKey,
      panelId,
      result,
      text: options.text,
      onRetry: options.onRetry,
    })}
  </article>`;
}

export function renderMemorySearchResults(options: {
  canLoadResult: (result: SearchResult) => boolean;
  details: ReadonlyMap<string, DetailState>;
  onRetry: (key: string, result: SearchResult) => void;
  onToggle: (result: SearchResult, index: number) => void;
  openResultKey: string | null;
  ready: Extract<SearchState, { kind: "ready" }>;
  text: Translate;
}) {
  const { ready, text } = options;
  const mode =
    ready.searchMode === "hybrid"
      ? text("memoryPage.memories.hybridSearch")
      : text("memoryPage.memories.keywordSearch");
  const resultCount = text("memoryPage.memories.results", {
    count: String(ready.results.length),
  });
  const sourceNotices = [
    ready.personalMemoryUnavailable
      ? text("memoryPage.memories.personalUnavailable")
      : ready.personalMemoryMethodUnavailable
        ? text("memoryPage.memories.personalMethodUnavailable")
        : null,
    ready.organizationMemoryUnavailable
      ? text("memoryPage.memories.organizationUnavailable")
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
          ${ready.results.map((result, index) => {
            const key = resultKey(result, index);
            const open = options.openResultKey === key;
            const expandable =
              options.details.get(key)?.kind === "ready" || options.canLoadResult(result);
            const panelId = `memory-detail-${index}`;
            const summary = html`
              <span class="settings-row__text">
                <span class="settings-row__title">${result.title ?? result.snippet}</span>
                ${result.title
                  ? html`<span class="settings-row__desc memory-memories__snippet"
                      >${result.snippet}</span
                    >`
                  : nothing}
                <span class="settings-row__desc memory-memories__path"
                  >${result.path} ·
                  ${text("memoryPage.memories.lineRange", {
                    start: String(result.startLine),
                    end: String(result.endLine),
                  })}</span
                >
              </span>
              <span class="settings-row__control memory-memories__meta">
                <span class="memory-memories__source"
                  >${result.source === "organization"
                    ? text("memoryPage.memories.sourceOrganization", {
                        scope: result.provenanceLabel ?? "",
                      })
                    : result.source === "wiki"
                      ? text("memoryPage.memories.sourceWiki")
                      : text(
                          result.source === "sessions"
                            ? "memoryPage.memories.sourceSessions"
                            : "memoryPage.memories.sourceMemory",
                        )}</span
                >
                <span
                  >${text("memoryPage.memories.score", { score: result.score.toFixed(2) })}</span
                >
              </span>
            `;
            return html`<article class="memory-memories__result">
              ${expandable
                ? html`<button
                    type="button"
                    class="settings-row settings-row--nav"
                    aria-expanded=${String(open)}
                    aria-controls=${panelId}
                    @click=${() => options.onToggle(result, index)}
                  >
                    ${summary}
                  </button>`
                : html`<div class="settings-row">${summary}</div>`}
              ${expandable
                ? renderDetail({
                    details: options.details,
                    key,
                    openResultKey: options.openResultKey,
                    panelId,
                    result,
                    text,
                    onRetry: options.onRetry,
                  })
                : nothing}
            </article>`;
          })}
        </div>`}
  `;
}
