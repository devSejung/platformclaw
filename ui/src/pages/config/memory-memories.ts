import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { AgentsWorkspaceGetResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "../../styles/memory-memories.css";
import {
  type BrowserMemorySearchResponse,
  type DetailState,
  isExpandableResult,
  renderMemoryBrowseFile,
  renderMemorySearchResults,
  resultKey,
  type SearchResult,
  type SearchState,
  type Translate,
} from "./memory-memories-view.ts";

type WikiSearchResult = {
  path: string;
  title: string;
  kind: string;
  score: number;
  snippet: string;
  startLine?: number;
  endLine?: number;
};
type WikiGetResult = { content: string; fromLine: number; lineCount: number };
type BrowseEntry = {
  path: string;
  name: string;
  updatedAtMs?: number;
};
type BrowseListResult = {
  entries: BrowseEntry[];
  hasAdditionalFolders?: boolean;
  truncated?: boolean;
};
type BrowserWorkspaceGetResult = {
  file: {
    path: string;
    name: string;
    encoding: "utf8";
    content: string;
    missing?: boolean;
    updatedAtMs?: number;
  };
};
type BrowseState =
  | { kind: "idle" | "loading" }
  | {
      kind: "ready";
      memory: BrowserWorkspaceGetResult["file"] | null;
      recent: BrowseEntry[];
      memoryError: string | null;
      recentError: string | null;
      additionalEntries: boolean;
    };

const RECENT_MEMORY_LIMIT = 7;

async function requestOutcome<T>(request: Promise<T>) {
  try {
    return { ok: true as const, value: await request };
  } catch (error) {
    return { ok: false as const, message: formatErrorMessage(error, { redact: redactToolDetail }) };
  }
}

class MemoryMemoriesElement extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property() connectionPhase: ApplicationGatewayPhase | "" = "";
  @property({ attribute: false }) methodAdvertised: boolean | null = true;
  @property({ attribute: false }) wikiSearchAdvertised: boolean | null = false;
  @property({ type: Boolean }) browseEnabled = false;
  @property({ attribute: false }) browseListAdvertised: boolean | null = false;
  @property({ attribute: false }) personalDetailAdvertised: boolean | null = true;
  @property({ attribute: false }) wikiGetAdvertised: boolean | null = false;
  @property({ attribute: false }) organizationGetAdvertised: boolean | null = false;
  @property({ attribute: false }) translator: Translate = t;
  @property() agentId: string | null = null;

  @state() private query = "";
  @state() private searchState: SearchState = { kind: "idle" };
  @state() private openResultKey: string | null = null;
  @state() private details = new Map<string, DetailState>();
  @state() private browseState: BrowseState = { kind: "idle" };
  @state() private browseRefresh: "idle" | "loading" | "done" = "idle";

  private searchRequest: object | null = null;
  private detailRequests = new Map<string, object>();
  private browseRequest: object | null = null;

  protected override willUpdate(changed: PropertyValues<this>) {
    const identityChanged = changed.has("agentId") || changed.has("client");
    const connectionChanged = changed.has("connected") || changed.has("connectionPhase");
    if (identityChanged) {
      this.resetSearch();
      this.resetBrowse();
    } else if (connectionChanged && !this.gatewayReady) {
      this.cancelPendingSearch();
      this.detailRequests.clear();
      this.discardTransientDetails();
      this.browseRequest = null;
      this.browseRefresh = "idle";
    }
    if (
      changed.has("methodAdvertised") ||
      changed.has("wikiSearchAdvertised") ||
      changed.has("personalDetailAdvertised") ||
      changed.has("wikiGetAdvertised") ||
      changed.has("organizationGetAdvertised")
    ) {
      this.resetSearch();
    }
    if (changed.has("personalDetailAdvertised") || changed.has("browseListAdvertised")) {
      if (
        (changed.has("personalDetailAdvertised") && this.personalDetailAdvertised === false) ||
        (changed.has("browseListAdvertised") && this.browseListAdvertised === false)
      ) {
        this.resetBrowse();
      } else {
        this.browseRequest = null;
        this.browseRefresh = "idle";
      }
    }
  }

  protected override updated(changed: PropertyValues<this>) {
    const identityChanged = changed.has("agentId") || changed.has("client");
    const connectionChanged = changed.has("connected") || changed.has("connectionPhase");
    if (
      this.gatewayReady &&
      this.browseEnabled &&
      (identityChanged ||
        connectionChanged ||
        changed.has("browseEnabled") ||
        changed.has("personalDetailAdvertised") ||
        changed.has("browseListAdvertised"))
    ) {
      queueMicrotask(() => void this.loadBrowse());
    }
  }

  private get phase(): ApplicationGatewayPhase {
    return this.connectionPhase || (this.connected ? "connected" : "offline");
  }

  private get gatewayReady() {
    return this.phase === "connected" && this.client !== null;
  }

  private get connectionLabel() {
    return this.text(
      this.phase === "connecting"
        ? "memoryPage.memories.connecting"
        : this.phase === "reconnecting"
          ? "memoryPage.memories.reconnecting"
          : "memoryPage.memories.offline",
    );
  }

  private text(key: string, params?: Record<string, string>) {
    return this.translator(key, params);
  }

  private resetSearch() {
    this.searchRequest = null;
    this.clearDetails(false);
    this.query = "";
    this.searchState = { kind: "idle" };
  }

  private resetBrowse() {
    this.browseRequest = null;
    this.clearDetails(true);
    this.browseState = { kind: "idle" };
    this.browseRefresh = "idle";
  }

  private clearDetails(browse: boolean) {
    const isTarget = (key: string) => key.startsWith("-") === browse;
    for (const key of this.detailRequests.keys()) {
      if (isTarget(key)) {
        this.detailRequests.delete(key);
      }
    }
    this.details = new Map([...this.details].filter(([key]) => !isTarget(key)));
    if (this.openResultKey && isTarget(this.openResultKey)) {
      this.openResultKey = null;
    }
  }

  private cancelPendingSearch() {
    this.searchRequest = null;
    if (this.searchState.kind === "loading") {
      this.searchState = { kind: "idle" };
    }
  }

  private discardTransientDetails() {
    const retained = new Map(
      [...this.details].filter(
        (entry): entry is [string, Extract<DetailState, { kind: "ready" }>] =>
          entry[1].kind === "ready",
      ),
    );
    if (this.openResultKey && !retained.has(this.openResultKey)) {
      this.openResultKey = null;
    }
    this.details = retained;
  }

  private async loadBrowse(refresh = false) {
    const client = this.gatewayReady ? this.client : null;
    const agentId = this.agentId;
    if (
      !client ||
      !agentId ||
      this.browseRequest ||
      (this.personalDetailAdvertised !== true && this.browseListAdvertised !== true)
    ) {
      return;
    }
    const request = { client, agentId };
    this.browseRequest = request;
    this.browseRefresh = refresh ? "loading" : "idle";
    if (refresh) {
      this.clearDetails(true);
    }
    if (this.browseState.kind !== "ready") {
      this.browseState = { kind: "loading" };
    }
    const previous = this.browseState.kind === "ready" ? this.browseState : null;
    const [memory, list] = await Promise.all([
      this.personalDetailAdvertised === true
        ? requestOutcome(
            client.request<BrowserWorkspaceGetResult>("agents.workspace.get", {
              agentId,
              path: "MEMORY.md",
            }),
          )
        : Promise.resolve(null),
      this.browseListAdvertised === true
        ? requestOutcome(
            client.request<BrowseListResult>("agents.workspace.list", {
              agentId,
              path: "memory",
            }),
          )
        : Promise.resolve(null),
    ]);
    if (
      this.browseRequest !== request ||
      !this.gatewayReady ||
      this.client !== client ||
      this.agentId !== agentId
    ) {
      return;
    }
    this.browseRequest = null;
    this.browseRefresh = refresh && memory?.ok !== false && list?.ok !== false ? "done" : "idle";
    const entries = list?.ok ? list.value.entries : [];
    const recent = entries.toSorted(
      (left, right) =>
        (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0) || left.path.localeCompare(right.path),
    );
    this.browseState = {
      kind: "ready",
      memory: memory?.ok ? memory.value.file : (previous?.memory ?? null),
      recent: list?.ok ? recent.slice(0, RECENT_MEMORY_LIMIT) : (previous?.recent ?? []),
      memoryError: memory?.ok === false ? memory.message : null,
      recentError: list?.ok === false ? list.message : null,
      additionalEntries:
        (list?.ok && list.value.truncated === true) ||
        (list?.ok && list.value.hasAdditionalFolders === true) ||
        recent.length > RECENT_MEMORY_LIMIT ||
        (list === null && (previous?.additionalEntries ?? false)),
    };
  }

  private async search(query: string) {
    const normalizedQuery = query.trim();
    const client = this.gatewayReady ? this.client : null;
    const agentId = this.agentId;
    if (
      !normalizedQuery ||
      !client ||
      !agentId ||
      (this.methodAdvertised !== true && this.wikiSearchAdvertised !== true)
    ) {
      return;
    }
    const request = { client, agentId, query: normalizedQuery };
    this.searchRequest = request;
    this.query = normalizedQuery;
    this.searchState = { kind: "loading", query: normalizedQuery };
    this.clearDetails(false);
    const [personal, wiki] = await Promise.all([
      this.methodAdvertised === true
        ? requestOutcome(
            client.request<BrowserMemorySearchResponse>("memory.search", {
              query: normalizedQuery,
              agentId,
            }),
          )
        : Promise.resolve(null),
      this.wikiSearchAdvertised === true
        ? requestOutcome(
            client.request<WikiSearchResult[]>("wiki.search", {
              query: normalizedQuery,
              agentId,
              maxResults: 50,
            }),
          )
        : Promise.resolve(null),
    ]);
    if (
      this.searchRequest !== request ||
      !this.gatewayReady ||
      this.agentId !== agentId ||
      this.client !== client
    ) {
      return;
    }
    if (personal?.ok !== true && wiki?.ok !== true) {
      this.searchState = {
        kind: "error",
        query: normalizedQuery,
        message:
          personal?.ok === false
            ? personal.message
            : wiki?.ok === false
              ? wiki.message
              : this.text("memoryPage.memories.gatewayUpdateRequired"),
      };
      return;
    }
    const result: BrowserMemorySearchResponse =
      personal?.ok === true
        ? personal.value
        : {
            agentId,
            provider: "personal-wiki",
            searchMode: "fts-only",
            results: [],
          };
    const wikiResults: SearchResult[] =
      wiki?.ok === true
        ? wiki.value.map((item) => ({
            path: item.path,
            title: item.title,
            kind: item.kind,
            score: item.score,
            snippet: item.snippet,
            startLine: item.startLine ?? 1,
            endLine: item.endLine ?? item.startLine ?? 1,
            source: "wiki",
          }))
        : [];
    this.searchState = {
      kind: "ready",
      query: normalizedQuery,
      ...result,
      results: [...result.results, ...wikiResults].toSorted(
        (left, right) => right.score - left.score,
      ),
      ...(personal === null && this.methodAdvertised === false
        ? { personalMemoryMethodUnavailable: true }
        : {}),
      ...(personal?.ok === false ? { personalMemoryUnavailable: true } : {}),
      ...(wiki === null && this.wikiSearchAdvertised === false
        ? { personalWikiMethodUnavailable: true }
        : {}),
      ...(wiki?.ok === false ? { personalWikiUnavailable: true } : {}),
      ...(personal?.ok !== true ? { organizationMemoryUnavailable: true } : {}),
    };
  }

  private toggleResult(result: SearchResult, index: number, content?: string) {
    const key = resultKey(result, index);
    const cached = content !== undefined || this.details.get(key)?.kind === "ready";
    if (!cached && !this.canLoadResult(result)) {
      return;
    }
    if (this.openResultKey === key) {
      this.openResultKey = null;
      return;
    }
    this.openResultKey = key;
    if (content !== undefined) {
      this.details = new Map(this.details).set(key, { kind: "ready", content });
    }
    if (!this.details.has(key)) {
      void this.loadDetail(key, result);
    }
  }

  private canLoadResult(result: SearchResult): boolean {
    if (!this.gatewayReady || !isExpandableResult(result)) {
      return false;
    }
    return result.source === "wiki"
      ? this.wikiGetAdvertised === true
      : result.source === "organization"
        ? this.organizationGetAdvertised === true
        : this.personalDetailAdvertised === true;
  }

  private async loadDetail(key: string, result: SearchResult) {
    const client = this.gatewayReady ? this.client : null;
    const agentId = this.agentId;
    if (!client || !agentId || !this.canLoadResult(result)) {
      return;
    }
    const request = { client, agentId, path: result.path };
    this.detailRequests.set(key, request);
    this.details = new Map(this.details).set(key, { kind: "loading" });
    try {
      const response =
        result.source === "wiki"
          ? await client.request<WikiGetResult>("wiki.get", {
              agentId,
              lookup: result.path,
            })
          : result.source === "organization"
            ? await client.request<WikiGetResult | null>("platformclaw.memory.get", {
                agentId,
                path: result.path,
              })
            : await client.request<AgentsWorkspaceGetResult>("agents.workspace.get", {
                agentId,
                path: result.path,
              });
      if (
        this.detailRequests.get(key) !== request ||
        !this.gatewayReady ||
        this.agentId !== agentId ||
        this.client !== client
      ) {
        return;
      }
      const detail: DetailState =
        response === null
          ? { kind: "error", message: this.text("memoryPage.memories.detailNotFound") }
          : "file" in response
            ? response.file.encoding === "utf8"
              ? { kind: "ready", content: response.file.content }
              : { kind: "error", message: this.text("memoryPage.memories.fileUnsupported") }
            : { kind: "ready", content: response.content };
      this.details = new Map(this.details).set(key, detail);
    } catch (error) {
      if (
        this.detailRequests.get(key) !== request ||
        !this.gatewayReady ||
        this.agentId !== agentId ||
        this.client !== client
      ) {
        return;
      }
      this.details = new Map(this.details).set(key, {
        kind: "error",
        message: formatErrorMessage(error, { redact: redactToolDetail }),
      });
    } finally {
      if (this.detailRequests.get(key) === request) {
        this.detailRequests.delete(key);
      }
    }
  }

  private focusSearch() {
    this.querySelector<HTMLInputElement>("#memory-search-input")?.focus();
  }

  private renderBrowseFile(
    path: string,
    name: string,
    index: number,
    description?: string,
    content?: string,
  ) {
    return renderMemoryBrowseFile({
      path,
      name,
      index,
      description,
      content,
      details: this.details,
      openResultKey: this.openResultKey,
      text: this.text.bind(this),
      canLoadResult: (result) => this.canLoadResult(result),
      onToggle: (result, resultIndex, inlineContent) =>
        this.toggleResult(result, resultIndex, inlineContent),
      onRetry: (key, result) => void this.loadDetail(key, result),
    });
  }

  private renderBrowseReady(ready: Extract<BrowseState, { kind: "ready" }>) {
    const memoryRow =
      ready.memoryError && !ready.memory
        ? nothing
        : !ready.memory || ready.memory.missing
          ? renderSettingsEmpty(this.text("memoryPage.memories.longTermEmpty"))
          : this.renderBrowseFile(
              "MEMORY.md",
              "MEMORY.md",
              -1,
              this.text("memoryPage.memories.previewHint"),
              ready.memory.content,
            );
    const longTerm =
      this.gatewayReady && this.personalDetailAdvertised === null
        ? renderSettingsEmpty(this.text("memoryPage.memories.capabilitiesLoading"))
        : this.gatewayReady && this.personalDetailAdvertised === false
          ? renderSettingsEmpty(this.text("memoryPage.memories.previewUnavailable"))
          : html`${ready.memoryError
              ? html`<div class="settings-empty" role="alert">
                  ${this.text("memoryPage.memories.browseErrorWithMessage", {
                    message: ready.memoryError,
                  })}
                </div>`
              : nothing}${memoryRow}`;
    const recentRows =
      this.gatewayReady && this.browseListAdvertised === null
        ? renderSettingsEmpty(this.text("memoryPage.memories.capabilitiesLoading"))
        : this.gatewayReady && this.browseListAdvertised === false
          ? renderSettingsEmpty(this.text("memoryPage.memories.recentUnavailable"))
          : ready.recentError && ready.recent.length === 0
            ? nothing
            : ready.recent.length === 0
              ? ready.additionalEntries
                ? nothing
                : renderSettingsEmpty(this.text("memoryPage.memories.recentEmpty"))
              : ready.recent.map((entry, index) =>
                  this.renderBrowseFile(entry.path, entry.name, -index - 2),
                );
    const refreshBusy = this.browseRefresh === "loading";
    return html`
      ${renderSettingsSection(
        {
          title: this.text("memoryPage.memories.longTermTitle"),
          description: this.text("memoryPage.memories.longTermDescription"),
          actions: html`<button
            class="btn btn--sm"
            ?disabled=${refreshBusy || !this.gatewayReady}
            @click=${() => void this.loadBrowse(true)}
          >
            ${this.text(
              refreshBusy ? "memoryPage.memories.refreshing" : "memoryPage.memories.refresh",
            )}
          </button>`,
        },
        html`${longTerm}${this.browseRefresh === "done"
          ? html`<p role="status">${this.text("memoryPage.memories.refreshed")}</p>`
          : nothing}`,
      )}
      ${renderSettingsSection(
        {
          title: this.text("memoryPage.memories.recentTitle"),
          description: this.text("memoryPage.memories.recentDescription"),
        },
        html`${ready.recentError
          ? html`<div class="settings-empty" role="alert">
              ${this.text("memoryPage.memories.recentPartialError", {
                message: ready.recentError,
              })}
            </div>`
          : nothing}${recentRows}${ready.additionalEntries
          ? renderSettingsRow({
              title: this.text("memoryPage.memories.recentMoreTitle"),
              description: this.text("memoryPage.memories.recentTruncated"),
              ...(this.methodAdvertised === true || this.wikiSearchAdvertised === true
                ? {
                    control: html`<button class="btn btn--sm" @click=${() => this.focusSearch()}>
                      ${this.text("memoryPage.memories.searchButton")}
                    </button>`,
                  }
                : {}),
            })
          : nothing}`,
      )}
    `;
  }

  private renderBrowse() {
    if (!this.browseEnabled) {
      return nothing;
    }
    if (
      this.phase === "connected" &&
      this.personalDetailAdvertised === false &&
      this.browseListAdvertised === false
    ) {
      return renderSettingsSection(
        { title: this.text("memoryPage.memories.longTermTitle") },
        renderSettingsEmpty(this.text("memoryPage.memories.browseUpdateRequired")),
      );
    }
    if (this.browseState.kind === "ready") {
      return this.renderBrowseReady(this.browseState);
    }
    return renderSettingsSection(
      { title: this.text("memoryPage.memories.longTermTitle") },
      html`<div class="settings-empty" role="status">
        ${this.gatewayReady
          ? this.text(
              this.personalDetailAdvertised === null || this.browseListAdvertised === null
                ? "memoryPage.memories.capabilitiesLoading"
                : "memoryPage.memories.browseLoading",
            )
          : this.connectionLabel}
      </div>`,
    );
  }

  private renderSearchState() {
    switch (this.searchState.kind) {
      case "loading":
        return html`<p class="memory-memories__state" role="status">
          ${this.text("memoryPage.memories.searching")}
        </p>`;
      case "error": {
        const failed = this.searchState;
        return html`<div class="memory-memories__state" role="alert">
          <p>${this.text("memoryPage.memories.error", { message: failed.message })}</p>
          <button class="btn btn--sm" @click=${() => void this.search(failed.query)}>
            ${this.text("memoryPage.memories.retry")}
          </button>
        </div>`;
      }
      case "ready":
        return renderMemorySearchResults({
          ready: this.searchState,
          details: this.details,
          openResultKey: this.openResultKey,
          text: this.text.bind(this),
          canLoadResult: (result) => this.canLoadResult(result),
          onToggle: (result, index) => this.toggleResult(result, index),
          onRetry: (key, result) => void this.loadDetail(key, result),
        });
      default:
        return nothing;
    }
  }

  override render() {
    const searchAvailable = this.methodAdvertised === true || this.wikiSearchAdvertised === true;
    const searchUnavailable =
      this.gatewayReady && this.methodAdvertised === false && this.wikiSearchAdvertised === false;
    const searchCapabilitiesLoading =
      this.gatewayReady &&
      !searchAvailable &&
      (this.methodAdvertised === null || this.wikiSearchAdvertised === null);
    const connectionStatus =
      this.browseEnabled && this.phase !== "connected" && this.browseState.kind === "ready"
        ? html`<div class="settings-empty" role="status">${this.connectionLabel}</div>`
        : nothing;
    return html`<div class="settings-page memory-memories">
      ${connectionStatus}${this.renderBrowse()}
      <section class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${this.text("memoryPage.memories.searchTitle")}</h2>
        </div>
        <p class="settings-section__desc">${this.text("memoryPage.memories.searchDescription")}</p>
        ${searchUnavailable
          ? renderSettingsEmpty(this.text("memoryPage.memories.gatewayUpdateRequired"))
          : html`<form
                class="memory-memories__search"
                role="search"
                @submit=${(event: SubmitEvent) => {
                  event.preventDefault();
                  void this.search(this.query);
                }}
              >
                <label class="settings-control__sr-label" for="memory-search-input"
                  >${this.text("memoryPage.memories.searchLabel")}</label
                >
                <input
                  id="memory-search-input"
                  type="search"
                  class="settings-input"
                  .value=${this.query}
                  placeholder=${this.text("memoryPage.memories.searchPlaceholder")}
                  @input=${(event: InputEvent) => {
                    const next = (event.currentTarget as HTMLInputElement).value;
                    if (next !== this.query) {
                      this.cancelPendingSearch();
                      this.clearDetails(false);
                      this.searchState = { kind: "idle" };
                    }
                    this.query = next;
                  }}
                />
                <button
                  class="btn btn--sm primary"
                  type="submit"
                  ?disabled=${!this.gatewayReady ||
                  !searchAvailable ||
                  !this.agentId ||
                  !this.query.trim() ||
                  this.searchState.kind === "loading"}
                >
                  ${this.text("memoryPage.memories.searchButton")}
                </button>
              </form>
              ${searchCapabilitiesLoading
                ? html`<p role="status">${this.text("memoryPage.memories.capabilitiesLoading")}</p>`
                : nothing}
              ${this.renderSearchState()}`}
      </section>
    </div>`;
  }
}

if (!customElements.get("openclaw-memory-memories")) {
  customElements.define("openclaw-memory-memories", MemoryMemoriesElement);
}
