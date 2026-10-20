// Control UI component renders the command palette.
import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { escapeRegExp } from "../../../src/shared/regexp.js";
import type { RouteId } from "../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import type { SessionSearchTarget } from "../lib/session-search-navigation.ts";
import {
  createSessionTranscriptSearchPager,
  sessionTranscriptSearchScope,
} from "../lib/session-transcript-search.ts";
import { getVisibleSessionRows } from "../lib/sessions/index.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../lib/string-coerce.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { isCommandPaletteShortcut } from "./command-palette-contract.ts";
import { icons, type IconName } from "./icons.ts";
import "./modal-dialog.ts";

type PaletteItem = {
  id: string;
  label: string;
  icon: IconName;
  category: "search" | "navigation" | "skills" | "chats";
  action: string;
  description?: string;
  snippet?: string;
  searchHit?: SessionSearchTarget;
};

const SESSION_ACTION_PREFIX = "session:";
const SESSION_SEARCH_DEBOUNCE_MS = 250;
const SESSION_SEARCH_LIMIT = 10;

function getPaletteBaseItems(): PaletteItem[] {
  return [
    {
      id: "nav-new-session",
      label: t("newSession.title"),
      icon: "plus",
      category: "navigation",
      action: "nav:new-session",
    },
    {
      id: "nav-sessions",
      label: t("palette.items.sessions"),
      icon: "fileText",
      category: "navigation",
      action: "nav:sessions",
    },
    {
      id: "nav-cron",
      label: t("palette.items.scheduled"),
      icon: "scrollText",
      category: "navigation",
      action: "nav:cron",
    },
    {
      id: "nav-skills",
      label: t("palette.items.skills"),
      icon: "zap",
      category: "navigation",
      action: "nav:skills",
    },
    {
      id: "nav-plugins",
      label: t("palette.items.plugins"),
      icon: "puzzle",
      category: "navigation",
      action: "nav:plugins",
    },
    {
      id: "nav-apps",
      label: t("palette.items.apps"),
      icon: "layoutGrid",
      category: "navigation",
      action: "nav:apps",
    },
    {
      id: "nav-config",
      label: t("palette.items.settings"),
      icon: "settings",
      category: "navigation",
      action: "nav:config",
    },
    {
      id: "nav-agents",
      label: t("palette.items.agents"),
      icon: "folder",
      category: "navigation",
      action: "nav:agents",
    },
    {
      id: "slash:verbose",
      label: "/verbose",
      icon: "terminal",
      category: "search",
      action: "/verbose full",
      description: t("palette.descriptions.verboseMode"),
    },
  ];
}

type CommandPaletteProps = {
  open: boolean;
  query: string;
  activeIndex: number;
  sessionItems: readonly PaletteItem[];
  onToggle: () => void;
  onQueryChange: (query: string) => void;
  onActiveIndexChange: (index: number) => void;
  onNavigate: (routeId: RouteId) => void;
  searchOnly: boolean;
  searchStatus: "idle" | "loading" | "results" | "error";
  indexing: boolean;
  hasMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onSelectSearchHit?: (target: SessionSearchTarget) => void;
  onSelectSession?: (sessionKey: string) => void;
  onSlashCommand?: (command: string) => void;
  onInputRef: (element: Element | undefined) => void;
};

function filteredItems(
  query: string,
  includeSlashCommands = true,
  sessionItems: readonly PaletteItem[] = [],
  searchOnly = false,
): PaletteItem[] {
  if (searchOnly) {
    return [...sessionItems];
  }
  const items = getPaletteBaseItems().filter(
    (item) => includeSlashCommands || item.category !== "search",
  );
  if (!query) {
    return items;
  }
  const q = normalizeLowercaseStringOrEmpty(query);
  const matches = items.filter(
    (item) =>
      normalizeLowercaseStringOrEmpty(item.label).includes(q) ||
      normalizeLowercaseStringOrEmpty(item.description).includes(q),
  );
  // Gateway search already matched the chat rows, so lead with those before
  // local navigation and slash-command matches.
  return [...sessionItems, ...matches];
}

function groupItems(items: PaletteItem[]): Array<[string, PaletteItem[]]> {
  const map = new Map<string, PaletteItem[]>();
  for (const item of items) {
    const group = map.get(item.category) ?? [];
    group.push(item);
    map.set(item.category, group);
  }
  return [...map.entries()];
}

const paletteDialogLabelId = "cmd-palette-label";
const paletteInputId = "cmd-palette-input";
const paletteListboxId = "cmd-palette-listbox";

function selectItem(item: PaletteItem, props: CommandPaletteProps) {
  if (item.searchHit) {
    props.onSelectSearchHit?.(item.searchHit);
  } else if (item.action.startsWith("nav:")) {
    props.onNavigate(item.action.slice(4) as RouteId);
  } else if (item.action.startsWith(SESSION_ACTION_PREFIX)) {
    props.onSelectSession?.(item.action.slice(SESSION_ACTION_PREFIX.length));
  } else {
    props.onSlashCommand?.(item.action);
  }
  props.onToggle();
}

function closePalette(props: CommandPaletteProps) {
  props.onToggle();
}

function scrollActiveIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector(".cmd-palette__item--active");
    el?.scrollIntoView({ block: "nearest" });
  });
}

function handleKeydown(e: KeyboardEvent, props: CommandPaletteProps) {
  if (e.isComposing) {
    return;
  }
  const items = filteredItems(
    props.query,
    Boolean(props.onSlashCommand),
    props.sessionItems,
    props.searchOnly,
  );
  if (items.length === 0 && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
    return;
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      props.onActiveIndexChange((props.activeIndex + 1) % items.length);
      scrollActiveIntoView();
      break;
    case "ArrowUp":
      e.preventDefault();
      props.onActiveIndexChange((props.activeIndex - 1 + items.length) % items.length);
      scrollActiveIntoView();
      break;
    case "Enter":
      e.preventDefault();
      {
        const item = items[props.activeIndex];
        if (item) {
          selectItem(item, props);
        }
      }
      break;
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      closePalette(props);
      break;
  }
}

function getCategoryLabel(category: string): string {
  switch (category) {
    case "search":
      return t("palette.categories.search");
    case "navigation":
      return t("palette.categories.navigation");
    case "skills":
      return t("palette.categories.skills");
    case "chats":
      return t("sessionsView.title");
    default:
      return category;
  }
}

function getOptionId(item: PaletteItem): string {
  return `cmd-palette-option-${item.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function focusInput(el: Element | undefined) {
  if (el instanceof HTMLInputElement) {
    requestAnimationFrame(() => {
      if (el.isConnected) {
        el.focus();
      }
    });
  }
}

function renderSearchSnippet(text: string, query: string) {
  const needle = query.trim();
  const match = needle ? new RegExp(escapeRegExp(needle), "iu").exec(text) : null;
  if (!match) {
    return text;
  }
  const end = match.index + match[0].length;
  return html`${text.slice(0, match.index)}<mark>${match[0]}</mark>${text.slice(end)}`;
}

function renderCommandPalette(props: CommandPaletteProps) {
  if (!props.open) {
    return nothing;
  }
  const items = filteredItems(
    props.query,
    Boolean(props.onSlashCommand),
    props.sessionItems,
    props.searchOnly,
  );
  const grouped = groupItems(items);
  const activeItem = items[props.activeIndex];
  const activeOptionId = activeItem ? getOptionId(activeItem) : nothing;
  const paletteLabel = props.searchOnly
    ? t("palette.conversationSearch")
    : t("palette.placeholder");

  return html`
    <openclaw-modal-dialog
      class="cmd-palette-overlay palette"
      label=${paletteLabel}
      style="--openclaw-modal-width: min(640px, calc(100vw - 32px));"
      @modal-cancel=${() => closePalette(props)}
    >
      <div
        class="cmd-palette"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => handleKeydown(e, props)}
      >
        <label id=${paletteDialogLabelId} class="cmd-palette__label" for=${paletteInputId}
          >${paletteLabel}</label
        >
        <input
          ${ref(props.onInputRef)}
          autofocus
          maxlength="4096"
          id=${paletteInputId}
          class="cmd-palette__input"
          role="combobox"
          aria-autocomplete="list"
          aria-controls=${paletteListboxId}
          aria-activedescendant=${activeOptionId}
          aria-expanded="true"
          placeholder=${paletteLabel}
          .value=${props.query}
          @input=${(e: Event) => {
            props.onQueryChange((e.target as HTMLInputElement).value);
            props.onActiveIndexChange(0);
          }}
        />
        <div
          class="cmd-palette__status"
          ?hidden=${props.searchStatus !== "loading" &&
          props.searchStatus !== "error" &&
          !props.indexing &&
          (!props.searchOnly || Boolean(props.query.trim()))}
          role="status"
          aria-live="polite"
        >
          ${props.searchStatus === "loading"
            ? t("sessionsView.transcriptSearchSearching")
            : props.searchStatus === "error"
              ? html`${t("sessionsView.transcriptSearchError")}
                  <button type="button" class="btn btn--sm" @click=${props.onRetry}>
                    ${t("sessionsView.transcriptSearchRetry")}
                  </button>`
              : props.indexing
                ? html`${t("sessionsView.transcriptSearchIndexing")}
                    <button type="button" class="btn btn--sm" @click=${props.onRetry}>
                      ${t("sessionsView.transcriptSearchRetry")}
                    </button>`
                : props.searchOnly && !props.query.trim()
                  ? t("palette.conversationSearchHint")
                  : nothing}
        </div>
        <div id=${paletteListboxId} class="cmd-palette__results" role="listbox">
          ${grouped.length === 0 &&
          props.query.trim() &&
          props.searchStatus === "results" &&
          !props.indexing &&
          !props.hasMore
            ? html`<div class="cmd-palette__empty">
                <span class="nav-item__icon" style="opacity:0.3;width:20px;height:20px"
                  >${icons.search}</span
                >
                <span>${t("palette.noResults")}</span>
              </div>`
            : grouped.map(
                ([category, groupedItems]) => html`
                  <div class="cmd-palette__group-label">${getCategoryLabel(category)}</div>
                  ${groupedItems.map((item) => {
                    const globalIndex = items.indexOf(item);
                    const isActive = globalIndex === props.activeIndex;
                    return html`
                      <div
                        id=${getOptionId(item)}
                        class="cmd-palette__item ${isActive ? "cmd-palette__item--active" : ""}"
                        role="option"
                        aria-selected=${isActive ? "true" : "false"}
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          selectItem(item, props);
                        }}
                        @mouseenter=${() => props.onActiveIndexChange(globalIndex)}
                      >
                        <span class="nav-item__icon">${icons[item.icon]}</span>
                        <span class="cmd-palette__item-content">
                          <span class="cmd-palette__item-title"
                            >${renderSearchSnippet(item.label, props.query)}</span
                          >
                          ${item.snippet
                            ? html`<span class="cmd-palette__snippet"
                                >${renderSearchSnippet(item.snippet, props.query)}</span
                              >`
                            : nothing}
                          ${item.description
                            ? html`<span class="cmd-palette__item-desc muted"
                                >${item.description}</span
                              >`
                            : nothing}
                        </span>
                      </div>
                    `;
                  })}
                `,
              )}
        </div>
        ${props.hasMore && props.searchStatus === "results"
          ? html`<button class="btn cmd-palette__more" type="button" @click=${props.onLoadMore}>
              ${t("palette.moreResults")}
            </button>`
          : nothing}
        <div class="cmd-palette__footer">
          <span><kbd>↑↓</kbd> ${t("palette.footer.navigate")}</span>
          <span><kbd>↵</kbd> ${t("palette.footer.select")}</span>
          <span><kbd>esc</kbd> ${t("palette.footer.close")}</span>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

export class CommandPalette extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) searchOnly = false;
  @property({ attribute: false }) onSelectSearchHit?: (target: SessionSearchTarget) => void;
  @property({ attribute: false }) onNavigate?: (routeId: RouteId) => void;
  @property({ attribute: false }) onSelectSession?: (sessionKey: string) => void;
  @property({ attribute: false }) onSlashCommand?: (command: string) => void;
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext<RouteId>;
  @state() private open = false;
  @state() private query = "";
  @state() private activeIndex = 0;
  @state() private sessionItems: readonly PaletteItem[] = [];
  @state() private searchStatus: CommandPaletteProps["searchStatus"] = "idle";
  @state() private indexing = false;
  @state() private hasMore = false;
  private nextOffset = 0;
  private searchPager: ReturnType<typeof createSessionTranscriptSearchPager> | undefined;
  private nextTitleOffset = 0;
  private bodyHasMore = false;
  private titlesHaveMore = false;

  private readonly subscriptions = new SubscriptionsController(this);
  private sessionSearchTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private sessionSearchId = 0;
  private sessionSearchSource?: {
    gateway: ApplicationContext<RouteId>["gateway"];
    client: ApplicationContext<RouteId>["gateway"]["snapshot"]["client"];
    connected: boolean;
  };

  constructor() {
    super();
    this.subscriptions
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.synchronizeGateway(gateway),
      )
      .watch(
        () => this.context?.agentSelection,
        (selection, notify) => selection.subscribe(notify),
        () => this.scheduleSessionSearch(this.query),
      );
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleGlobalKeydown);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleGlobalKeydown);
    this.open = false;
    this.query = "";
    this.activeIndex = 0;
    this.clearSessionSearch();
    this.sessionSearchSource = undefined;
    super.disconnectedCallback();
  }

  openPalette() {
    if (this.open) {
      focusInput(this.querySelector(".cmd-palette__input") ?? undefined);
      return;
    }
    this.open = true;
    this.query = "";
    this.activeIndex = 0;
    this.clearSessionSearch();
  }

  get isOpen(): boolean {
    return this.open;
  }

  readonly togglePalette = () => {
    if (this.open) {
      this.open = false;
      this.clearSessionSearch();
      return;
    }
    this.openPalette();
  };

  private readonly handleInputRef = (element: Element | undefined) => {
    if (this.open) {
      focusInput(element);
    }
  };

  private synchronizeGateway(gateway: ApplicationContext<RouteId>["gateway"]) {
    const snapshot = gateway.snapshot;
    const previous = this.sessionSearchSource;
    const sourceChanged = previous?.gateway !== gateway;
    const clientChanged = previous?.client !== snapshot.client;
    const reconnected = previous?.connected === false && snapshot.phase === "connected";
    this.sessionSearchSource = {
      gateway,
      client: snapshot.client,
      connected: snapshot.phase === "connected",
    };

    if (sourceChanged || clientChanged || snapshot.phase !== "connected") {
      // Query results belong to one runtime/client connection. Discard them as
      // soon as that owner changes so detached or reconnecting rows stay inert.
      this.clearSessionSearch();
    }
    if (snapshot.phase === "connected" && (sourceChanged || clientChanged || reconnected)) {
      this.scheduleSessionSearch(this.query);
    } else if (snapshot.phase !== "connected" && this.open && this.query.trim()) {
      this.searchStatus = "error";
    }
  }

  private clearSessionSearch() {
    if (this.sessionSearchTimer !== null) {
      globalThis.clearTimeout(this.sessionSearchTimer);
      this.sessionSearchTimer = null;
    }
    this.sessionSearchId += 1;
    this.sessionItems = [];
    this.searchStatus = "idle";
    this.indexing = false;
    this.hasMore = false;
    this.nextOffset = 0;
    this.searchPager = undefined;
    this.nextTitleOffset = 0;
    this.bodyHasMore = false;
    this.titlesHaveMore = false;
  }

  private scheduleSessionSearch(query: string) {
    if (this.sessionSearchTimer !== null) {
      globalThis.clearTimeout(this.sessionSearchTimer);
      this.sessionSearchTimer = null;
    }
    // Invalidate the previous query immediately so late responses cannot
    // repopulate selectable stale rows during the debounce window.
    this.sessionSearchId += 1;
    this.sessionItems = [];
    const search = normalizeOptionalString(query);
    this.searchStatus = "idle";
    this.indexing = false;
    this.hasMore = false;
    this.nextOffset = 0;
    this.searchPager = undefined;
    this.nextTitleOffset = 0;
    this.bodyHasMore = false;
    this.titlesHaveMore = false;
    if (!this.open || !search || (!this.onSelectSession && !this.onSelectSearchHit)) {
      return;
    }
    this.searchStatus = "loading";
    this.sessionSearchTimer = globalThis.setTimeout(() => {
      this.sessionSearchTimer = null;
      void this.searchSessions(search);
    }, SESSION_SEARCH_DEBOUNCE_MS);
  }

  private async searchSessions(search: string, append = false) {
    const context = this.context;
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    if (!context || gateway?.snapshot.phase !== "connected" || !client) {
      this.searchStatus = "error";
      return;
    }
    const requestId = ++this.sessionSearchId;
    this.searchStatus = "loading";
    const offset = append ? this.nextOffset : 0;
    const titleOffset = append ? this.nextTitleOffset : 0;
    const isCurrent = () =>
      requestId === this.sessionSearchId &&
      this.open &&
      this.context === context &&
      gateway.snapshot.client === client &&
      gateway.snapshot.phase === "connected";
    try {
      const scope = sessionTranscriptSearchScope(context);
      if (!append || !this.searchPager) {
        this.searchPager = createSessionTranscriptSearchPager(client, {
          query: search,
          ...scope,
          limit: SESSION_SEARCH_LIMIT,
        });
      }
      const [result, titles] = await Promise.all([
        append && !this.bodyHasMore
          ? Promise.resolve({ results: [], hasMore: false, totalCount: 0, indexing: false })
          : this.searchPager.next(),
        append && !this.titlesHaveMore
          ? Promise.resolve(null)
          : context.sessions.list({
              search,
              offset: titleOffset,
              limit: SESSION_SEARCH_LIMIT,
              archivedFilter: "all",
              includeGlobal: false,
              includeUnknown: false,
              agentId: scope.agentId,
            }),
      ]);
      if (!isCurrent()) {
        return;
      }
      if (!titles && (!append || this.titlesHaveMore)) {
        throw new Error("Session title search failed");
      }
      const rows = context.sessions.state?.result?.sessions ?? [];
      const items = result.results.map((hit, index): PaletteItem => {
        const row = rows.find((entry) => entry.key === hit.sessionKey);
        return {
          id: `hit-${offset + index}`,
          label: hit.title || resolveSessionDisplayName(hit.sessionKey, row),
          icon: "messageSquare",
          category: "chats",
          action: `${SESSION_ACTION_PREFIX}${hit.sessionKey}`,
          snippet: hit.snippet,
          description: `${t(`sessionsView.${hit.role}`)} · ${formatRelativeTimestamp(hit.timestamp, { fallback: "" })}`,
          searchHit: {
            sessionKey: hit.sessionKey,
            sessionId: hit.sessionId,
            messageId: hit.messageId,
            query: search,
          },
        };
      });
      const titleItems = getVisibleSessionRows(titles, {
        agentId: "",
        defaultAgentId: "",
        filterByAgent: false,
        archivedFilter: "all",
      })
        .filter((row) => !result.results.some((hit) => hit.sessionKey === row.key))
        .map(
          (row): PaletteItem => ({
            id: `session-${row.key}`,
            label: resolveSessionDisplayName(row.key, row),
            icon: "messageSquare",
            category: "chats",
            action: `${SESSION_ACTION_PREFIX}${row.key}`,
            description: t("palette.titleMatch"),
          }),
        );
      this.sessionItems = append
        ? [...this.sessionItems, ...titleItems, ...items]
        : [...titleItems, ...items];
      this.nextOffset = offset + result.results.length;
      this.indexing = result.indexing === true;
      this.bodyHasMore = result.hasMore === true;
      this.titlesHaveMore = titles?.hasMore === true;
      this.nextTitleOffset = titles?.nextOffset ?? titleOffset + (titles?.sessions.length ?? 0);
      this.hasMore = this.bodyHasMore || this.titlesHaveMore;
      this.searchStatus = "results";
      if (!append) {
        this.activeIndex = 0;
      }
    } catch {
      if (isCurrent()) {
        this.searchStatus = "error";
      }
    }
  }

  private readonly handleGlobalKeydown = (event: KeyboardEvent) => {
    if (event.isComposing) {
      return;
    }
    if (!event.defaultPrevented && event.key === "Escape" && this.open) {
      event.preventDefault();
      this.togglePalette();
      return;
    }
    if (!event.defaultPrevented && isCommandPaletteShortcut(event)) {
      event.preventDefault();
      this.togglePalette();
    }
  };

  override render() {
    return renderCommandPalette({
      open: this.open,
      query: this.query,
      activeIndex: this.activeIndex,
      sessionItems: this.sessionItems,
      searchOnly: this.searchOnly,
      searchStatus: this.searchStatus,
      indexing: this.indexing,
      hasMore: this.hasMore,
      onRetry: () => void this.searchSessions(this.query.trim()),
      onLoadMore: () => void this.searchSessions(this.query.trim(), true),
      onSelectSearchHit: this.onSelectSearchHit,
      onToggle: this.togglePalette,
      onQueryChange: (query) => {
        this.query = query;
        this.activeIndex = 0;
        this.scheduleSessionSearch(query);
      },
      onActiveIndexChange: (index) => {
        this.activeIndex = index;
      },
      onNavigate: (routeId) => this.onNavigate?.(routeId),
      onSelectSession: this.onSelectSession,
      onSlashCommand: this.onSlashCommand,
      onInputRef: this.handleInputRef,
    });
  }
}

if (!customElements.get("openclaw-command-palette")) {
  customElements.define("openclaw-command-palette", CommandPalette);
}
