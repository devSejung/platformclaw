import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { AgentsWorkspaceGetResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import { renderSettingsEmpty } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "../../styles/memory-memories.css";
import { renderMemoryBrowse } from "./memory-memories-browse-view.ts";
import {
  type BrowserMemorySearchResponse,
  type BrowseListResult,
  type BrowserWorkspaceGetResult,
  type BrowseState,
  type MemoryResultActions,
  type MemorySourceFilter,
  type DetailState,
  isExpandableResult,
  renderMemoryConnectionStatus,
  renderMemoryBrowseFile,
  renderMemorySearchState,
  renderMemorySearchForm,
  resultKey,
  type SearchResult,
  type SearchState,
  type Translate,
  type WikiGetResult,
  type WikiSearchResult,
} from "./memory-memories-view.ts";
import {
  memorySearchResultIdentity,
  type MemorySearchNavigationState,
} from "./memory-search-navigation.ts";

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
  @property({ type: Boolean }) unifiedSearch = false;
  @property({ type: Boolean }) compactSearch = false;
  @property({ type: Boolean }) documentDialogs = false;
  @property() searchPlaceholder: string | null = null;
  @property({ type: Boolean }) vaultGetAdvertised = false;
  @property() vaultId: string | null = null;
  @property() searchScope: "connected" | "all" = "connected";
  @property({ attribute: false }) browseListAdvertised: boolean | null = false;
  @property({ attribute: false }) personalDetailAdvertised: boolean | null = true;
  @property({ attribute: false }) wikiGetAdvertised: boolean | null = false;
  @property({ attribute: false }) translator: Translate = t;
  @property() agentId: string | null = null;
  @property({ attribute: false }) itemActions?: MemoryResultActions;
  @property({ type: Number }) refreshRevision = 0;
  @property({ attribute: false }) openVaultDocument?: (vaultId: string, documentId: string) => void;
  @property({ attribute: false }) navigationState: MemorySearchNavigationState | null = null;

  @state() private query = "";
  @state() private searchState: SearchState = { kind: "idle" };
  @state() private sourceFilter: MemorySourceFilter = "all";
  @state() private openResultKey: string | null = null;
  @state() private details = new Map<string, DetailState>();
  @state() private browseState: BrowseState = { kind: "idle" };
  @state() private browseRefresh: "idle" | "loading" | "done" = "idle";

  private searchRequest: object | null = null;
  private detailRequests = new Map<string, object>();
  private browseRequest: object | null = null;
  private restoreNavigation: MemorySearchNavigationState | null = null;
  private restoreScrollTop: number | null = null;
  private scrollContainer: HTMLElement | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.scrollContainer = this.closest<HTMLElement>("#control-ui-main");
  }

  override disconnectedCallback() {
    if (this.navigationState) {
      const selected =
        this.searchState.kind === "ready"
          ? this.searchState.results.find(
              (result, index) => resultKey(result, index) === this.openResultKey,
            )
          : undefined;
      Object.assign(this.navigationState, {
        kind: this.searchState.kind === "idle" ? "draft" : "search",
        query: this.query,
        sourceFilter: this.sourceFilter,
        selectedResult: selected ? memorySearchResultIdentity(selected) : null,
        scrollTop: this.scrollContainer?.scrollTop ?? 0,
      } satisfies MemorySearchNavigationState);
    }
    this.searchRequest = this.browseRequest = null;
    this.detailRequests.clear();
    this.scrollContainer = null;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    const identityChanged = changed.has("agentId") || changed.has("client");
    const connectionChanged = changed.has("connected") || changed.has("connectionPhase");
    if (identityChanged) {
      this.resetSearch();
      this.resetBrowse();
    } else if (changed.has("refreshRevision")) {
      // Mutations refresh results without changing the user's query or source filter.
      this.cancelPendingSearch();
      this.clearDetails(false);
      this.searchState = { kind: "idle" };
      this.resetBrowse();
    } else if (
      changed.has("vaultId") ||
      changed.has("searchScope") ||
      changed.has("unifiedSearch")
    ) {
      // Search scope does not own cached workspace files or their loaded details.
      this.resetSearch();
    }
    if (connectionChanged && !this.gatewayReady) {
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
      changed.has("wikiGetAdvertised")
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
    if (changed.has("navigationState")) {
      this.resetSearch();
      this.resetBrowse();
      const navigation = this.navigationState;
      this.query = navigation?.query ?? "";
      this.sourceFilter = navigation?.sourceFilter ?? "all";
      this.restoreNavigation = navigation?.kind === "search" ? { ...navigation } : null;
      this.restoreScrollTop = navigation?.scrollTop ?? null;
    } else if (
      identityChanged ||
      changed.has("vaultId") ||
      changed.has("searchScope") ||
      (changed.has("unifiedSearch") && !this.restoreNavigation) ||
      (this.methodAdvertised === false && this.wikiSearchAdvertised === false)
    ) {
      this.restoreNavigation = null;
      this.restoreScrollTop = null;
    } else if (this.restoreNavigation) {
      // Capability discovery can finish after this page remounts. Keep only its
      // intent while resetSearch discards results; the current catalog gates the requery.
      this.query = this.restoreNavigation.query;
      this.sourceFilter = this.restoreNavigation.sourceFilter;
    }
  }

  protected override updated(changed: PropertyValues<this>) {
    const identityChanged = changed.has("agentId") || changed.has("client");
    const connectionChanged = changed.has("connected") || changed.has("connectionPhase");
    if (
      this.restoreNavigation &&
      this.gatewayReady &&
      this.methodAdvertised !== null &&
      this.wikiSearchAdvertised !== null &&
      (this.methodAdvertised || this.wikiSearchAdvertised)
    ) {
      const navigation = this.restoreNavigation;
      const navigationOwner = this.navigationState;
      this.restoreNavigation = null;
      void this.search(navigation.query, true).then((restored) => {
        if (
          !restored ||
          !this.isConnected ||
          !this.gatewayReady ||
          this.navigationState !== navigationOwner ||
          this.searchState !== restored
        ) {
          return;
        }
        const index = restored.results.findIndex(
          (result) =>
            memorySearchResultIdentity(result) === navigation.selectedResult &&
            (this.sourceFilter === "all" || result.source === this.sourceFilter),
        );
        const result = restored.results[index];
        if (result) {
          this.toggleResult(result, index);
        }
      });
    }
    if (
      changed.has("refreshRevision") &&
      changed.get("refreshRevision") !== undefined &&
      this.gatewayReady &&
      this.query.trim()
    ) {
      void this.search(this.query, true);
    }
    if (
      this.gatewayReady &&
      this.browseEnabled &&
      (identityChanged ||
        connectionChanged ||
        changed.has("browseEnabled") ||
        changed.has("refreshRevision") ||
        changed.has("personalDetailAdvertised") ||
        changed.has("browseListAdvertised"))
    ) {
      queueMicrotask(() => void this.loadBrowse());
    }
    if (
      this.restoreScrollTop !== null &&
      !this.restoreNavigation &&
      this.searchState.kind !== "loading" &&
      (!this.browseEnabled || this.browseState.kind === "ready") &&
      this.detailRequests.size === 0
    ) {
      if (this.scrollContainer) {
        this.scrollContainer.scrollTop = this.restoreScrollTop;
      }
      this.restoreScrollTop = null;
    }
  }

  private get phase(): ApplicationGatewayPhase {
    return this.connectionPhase || (this.connected ? "connected" : "offline");
  }

  private get gatewayReady() {
    return this.phase === "connected" && this.client !== null;
  }

  private isCurrentRequest(request: { client: GatewayBrowserClient; agentId: string }) {
    return this.gatewayReady && this.client === request.client && this.agentId === request.agentId;
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
    this.sourceFilter = "all";
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
    if (this.browseRequest !== request || !this.isCurrentRequest(request)) {
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

  private async search(
    query: string,
    preserveFilter = false,
  ): Promise<Extract<SearchState, { kind: "ready" }> | null> {
    const normalizedQuery = query.trim();
    const client = this.gatewayReady ? this.client : null;
    const agentId = this.agentId;
    if (
      !normalizedQuery ||
      !client ||
      !agentId ||
      (this.methodAdvertised !== true && this.wikiSearchAdvertised !== true)
    ) {
      return null;
    }
    const request = { client, agentId, query: normalizedQuery };
    this.searchRequest = request;
    this.query = normalizedQuery;
    if (!preserveFilter) {
      this.sourceFilter = "all";
    }
    this.searchState = { kind: "loading", query: normalizedQuery };
    this.clearDetails(false);
    const [personal, wiki] = await Promise.all([
      this.methodAdvertised === true
        ? requestOutcome(
            client.request<BrowserMemorySearchResponse>("memory.search", {
              query: normalizedQuery,
              agentId,
              ...(this.vaultId ? { vaultId: this.vaultId } : {}),
              ...(this.unifiedSearch && this.searchScope === "all" ? { scope: "all" } : {}),
            }),
          )
        : Promise.resolve(null),
      !this.unifiedSearch && this.wikiSearchAdvertised === true
        ? requestOutcome(
            client.request<WikiSearchResult[]>("wiki.search", {
              query: normalizedQuery,
              agentId,
              ...(this.vaultId ? { vaultId: this.vaultId } : {}),
              maxResults: 50,
            }),
          )
        : Promise.resolve(null),
    ]);
    if (this.searchRequest !== request || !this.isCurrentRequest(request)) {
      return null;
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
      return null;
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
      results: this.unifiedSearch
        ? result.results
        : [...result.results, ...wikiResults].toSorted((left, right) => right.score - left.score),
      ...(personal === null && this.methodAdvertised === false
        ? { personalMemoryMethodUnavailable: true }
        : {}),
      ...(personal?.ok === false ? { personalMemoryUnavailable: true } : {}),
      ...(!this.unifiedSearch && wiki === null && this.wikiSearchAdvertised === false
        ? { personalWikiMethodUnavailable: true }
        : {}),
      ...(wiki?.ok === false ? { personalWikiUnavailable: true } : {}),
    };
    return this.searchState;
  }

  private toggleResult(result: SearchResult, index: number, content?: string) {
    if (
      (result.source === "wiki" || result.vaultType === "shared") &&
      result.vaultId &&
      result.documentId &&
      this.openVaultDocument
    ) {
      if (this.canLoadResult(result)) {
        this.openVaultDocument(result.vaultId, result.documentId);
      }
      return;
    }
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
    return result.vaultType === "shared" ||
      (result.source === "wiki" && this.openVaultDocument && result.vaultId && result.documentId)
      ? this.vaultGetAdvertised
      : result.source === "wiki"
        ? this.wikiGetAdvertised === true
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
        result.vaultType === "shared"
          ? await client.request<WikiGetResult>("platformclaw.vault.document.get", {
              vaultId: result.vaultId,
              documentId: result.documentId,
            })
          : result.source === "wiki"
            ? await client.request<WikiGetResult>("wiki.document.get", {
                agentId,
                lookup: result.path,
              })
            : await client.request<AgentsWorkspaceGetResult>("agents.workspace.get", {
                agentId,
                path: result.path,
              });
      if (this.detailRequests.get(key) !== request || !this.isCurrentRequest(request)) {
        return;
      }
      const detail: DetailState =
        response === null
          ? { kind: "error", message: this.text("memoryPage.memories.detailNotFound") }
          : "file" in response
            ? response.file.encoding === "utf8"
              ? { kind: "ready", content: response.file.content }
              : { kind: "error", message: this.text("memoryPage.memories.fileUnsupported") }
            : {
                kind: "ready",
                content: response.displayContent ?? response.content ?? "",
              };
      this.details = new Map(this.details).set(key, detail);
    } catch (error) {
      if (this.detailRequests.get(key) !== request || !this.isCurrentRequest(request)) {
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
    updatedAtMs?: number,
  ) {
    return renderMemoryBrowseFile({
      actions: this.gatewayReady ? this.itemActions : undefined,
      onClose: this.documentDialogs ? () => (this.openResultKey = null) : undefined,
      path,
      name,
      index,
      description,
      content,
      updatedAtMs,
      details: this.details,
      openResultKey: this.openResultKey,
      text: this.text.bind(this),
      canLoadResult: (result) => this.canLoadResult(result),
      onToggle: (result, resultIndex, inlineContent) =>
        this.toggleResult(result, resultIndex, inlineContent),
      onRetry: (key, result) => void this.loadDetail(key, result),
    });
  }

  private renderBrowse() {
    return renderMemoryBrowse(this.browseState, {
      enabled: this.browseEnabled,
      connected: this.phase === "connected",
      connectionLabel: this.connectionLabel,
      gatewayReady: this.gatewayReady,
      personalDetailAdvertised: this.personalDetailAdvertised,
      browseListAdvertised: this.browseListAdvertised,
      browseRefresh: this.browseRefresh,
      searchAvailable: this.methodAdvertised === true || this.wikiSearchAdvertised === true,
      renderFile: this.renderBrowseFile.bind(this),
      text: this.text.bind(this),
      onRefresh: () => void this.loadBrowse(true),
      onFocusSearch: () => this.focusSearch(),
    });
  }

  private renderSearchState() {
    return renderMemorySearchState({
      actions: this.gatewayReady ? this.itemActions : undefined,
      canLoadResult: (result) => this.canLoadResult(result),
      details: this.details,
      onRetry: (key, result) => void this.loadDetail(key, result),
      onSearch: (query) => void this.search(query),
      onSourceFilterChange: (source) => {
        this.sourceFilter = source;
      },
      onToggle: (result, index) => this.toggleResult(result, index),
      openResultKey: this.openResultKey,
      searchState: this.searchState,
      vaultDocumentDialog: Boolean(this.openVaultDocument),
      onClose: this.documentDialogs ? () => (this.openResultKey = null) : undefined,
      sourceFilter: this.sourceFilter,
      text: this.text.bind(this),
    });
  }

  override render() {
    const searchAvailable = this.methodAdvertised === true || this.wikiSearchAdvertised === true;
    const searchUnavailable =
      this.gatewayReady && this.methodAdvertised === false && this.wikiSearchAdvertised === false;
    const searchCapabilitiesLoading =
      this.gatewayReady &&
      !searchAvailable &&
      (this.methodAdvertised === null || this.wikiSearchAdvertised === null);
    const connectionStatus = renderMemoryConnectionStatus({
      browseEnabled: this.browseEnabled,
      connected: this.phase === "connected",
      browseReady: this.browseState.kind === "ready",
      label: this.connectionLabel,
    });
    return html`<div class="settings-page memory-memories">
      ${connectionStatus}
      <section class="settings-section">
        ${this.compactSearch
          ? nothing
          : html`<div class="settings-section__header">
                <h2 class="settings-section__heading">
                  ${this.text("memoryPage.memories.searchTitle")}
                </h2>
              </div>
              <p class="settings-section__desc">
                ${this.text("memoryPage.memories.searchDescription")}
              </p>`}
        ${searchUnavailable
          ? renderSettingsEmpty(this.text("memoryPage.memories.gatewayUpdateRequired"))
          : html`${renderMemorySearchForm({
              text: this.text.bind(this),
              query: this.query,
              placeholder: this.searchPlaceholder,
              disabled:
                !this.gatewayReady ||
                !searchAvailable ||
                !this.agentId ||
                !this.query.trim() ||
                this.searchState.kind === "loading",
              onSubmit: () => void this.search(this.query),
              onInput: (next) => {
                if (next !== this.query) {
                  this.restoreNavigation = null;
                  this.restoreScrollTop = null;
                  this.cancelPendingSearch();
                  this.clearDetails(false);
                  this.searchState = { kind: "idle" };
                }
                this.query = next;
              },
            })}
            ${searchCapabilitiesLoading
              ? html`<p role="status">${this.text("memoryPage.memories.capabilitiesLoading")}</p>`
              : nothing}
            ${this.renderSearchState()}`}
      </section>
      ${this.renderBrowse()}
    </div>`;
  }
}

if (!customElements.get("openclaw-memory-memories")) {
  customElements.define("openclaw-memory-memories", MemoryMemoriesElement);
}
