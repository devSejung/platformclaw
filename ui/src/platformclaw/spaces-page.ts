import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import type {
  Space,
  SpacePage,
  SpaceRole,
  SpaceConversation,
} from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import type { SpaceMessage } from "../../../packages/platformclaw-control-plane/src/space-service.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT } from "./i18n.ts";
import {
  renderSpaceConversation,
  SpaceConversationHistoryState,
} from "./space-conversation-history.ts";
import { requestSpaceGateway, spaceGatewayErrorMessage } from "./space-gateway-request.ts";
import { renderSpaceMembers } from "./space-members-view.ts";
import { SpacePeopleSearch } from "./space-people-search.ts";
import "../styles/chat.css";
import "../pages/chat/chat-pane.ts";
import { renderSpacesView, type SpaceSnapshot, type SpaceSearchHit } from "./spaces-view.ts";
import "./spaces.css";
const t = (key: string) => platformClawT(`platformClaw.spaces.${key}`);
export class PlatformClawSpacesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @state() private spaces: Space[] = [];
  @state() private snapshot: SpaceSnapshot | null = null;
  @state() private page: SpacePage | null = null;
  @state() private messages: SpaceMessage[] = [];
  @state() private conversation: SpaceConversation | null = null;
  private readonly conversationHistory = new SpaceConversationHistoryState(() =>
    this.requestUpdate(),
  );
  @state() private expandedPages = new Set<string>();
  @state() private error = "";
  @state() private notice = "";
  @state() private historyAnchor = "";
  @state() private loading = false;
  @state() private busy = false;
  // Keep the draft's original revision when membership revalidation refreshes the page.
  @state() private editing: SpacePage | null = null;
  @state() private membersOpen = false;
  @state() private notesOpen = false;
  @state() private navigationOpen = false;
  private followConversation = true;
  @state() private creating: "space" | "page" | "conversation" | null = null;
  @state() private draftTitle = "";
  @state() private body = "";
  private newParentId: string | undefined;
  @state() private query = "";
  @state() private hits: SpaceSearchHit[] = [];
  private readonly peopleSearch = new SpacePeopleSearch(() => this.requestUpdate());
  @state() private pendingMember: { userId: string; label: string; role: SpaceRole | null } | null =
    null;
  private epoch = 0;
  private historyEpoch = 0;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeState: (() => void) | undefined;
  private historyTimer: ReturnType<typeof setTimeout> | undefined;
  private createRequestId = crypto.randomUUID();
  private gatewayClient: unknown;
  private gatewayConnected = false;
  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }
  override disconnectedCallback() {
    this.peopleSearch.clear();
    this.epoch++;
    this.historyEpoch++;
    this.conversationHistory.clear();
    this.unsubscribe?.();
    this.unsubscribeState?.();
    clearTimeout(this.historyTimer);
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues) {
    if (changed.has("messages") || changed.has("page")) {
      const history = this.querySelector<HTMLElement>(".pc-space-history");
      if (this.historyAnchor) {
        this.querySelector<HTMLElement>('[data-source="true"]')?.scrollIntoView?.({
          block: "center",
        });
      } else if (history && this.followConversation) {
        history.scrollTop = history.scrollHeight;
      }
    }
    if (!this.context?.gateway) {
      return;
    }
    const gateway = this.context.gateway;
    const reconnected = !this.gatewayConnected && gateway.snapshot.phase === "connected";
    this.gatewayConnected = gateway.snapshot.phase === "connected";
    if (!this.unsubscribeState) {
      this.unsubscribeState = gateway.subscribe(() => this.requestUpdate());
    }
    if (this.gatewayClient !== gateway.snapshot.client) {
      this.gatewayClient = gateway.snapshot.client;
      this.epoch++;
      this.historyEpoch++;
      this.clearSensitive();
      this.spaces = [];
      this.unsubscribe?.();
      this.unsubscribe = gateway.subscribeEvents((event) => {
        if (event.event === "platformclaw.spaces.invalidated") {
          void this.refresh(true);
        }
        if (event.event === "platformclaw.space.changed" && this.page) {
          const payload = event.payload as { spaceId?: string; pageId?: string };
          if (payload?.pageId === this.page.id && payload.spaceId === this.snapshot?.space.id) {
            this.scheduleHistory();
          }
        }
      });
      if (gateway.snapshot.phase === "connected") {
        void this.refresh();
      }
    } else if (reconnected) {
      void this.refresh(true);
    }
    if (gateway.snapshot.phase !== "connected") {
      this.conversation = null;
      this.conversationHistory.clear();
      if (this.messages.length) {
        this.messages = [];
      }
      if (this.hits.length) {
        this.hits = [];
      }

      this.peopleSearch.clear();
      this.pendingMember = null;
      this.historyEpoch++;
      clearTimeout(this.historyTimer);
    }
  }
  private rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return requestSpaceGateway<T>(() => this.context, method, params);
  }
  private clearSensitive() {
    this.snapshot = null;
    this.page = null;
    this.messages = [];
    this.conversation = null;
    this.conversationHistory.clear();
    this.hits = [];
    this.clearDraft();
    this.membersOpen = false;
    this.notesOpen = false;
    this.peopleSearch.clear();
    this.pendingMember = null;
  }
  private async refresh(revalidate = false) {
    this.peopleSearch.clear();
    this.pendingMember = null;
    const epoch = ++this.epoch;
    this.loading = true;
    if (!revalidate) {
      this.error = "";
    }
    const selected = this.snapshot?.space.id ?? new URL(location.href).searchParams.get("space");
    try {
      const spaces = await this.rpc<Space[]>("list");
      if (epoch !== this.epoch) {
        return;
      }
      this.spaces = spaces;
      if (selected && spaces.some((space) => space.id === selected)) {
        await this.selectSpace(selected, revalidate);
      } else if (selected) {
        this.clearSensitive();
        this.error = t("lostAccess");
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.clearSensitive();
        this.error = spaceGatewayErrorMessage(error);
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
      }
    }
  }
  private async selectSpace(id: string, revalidate = false) {
    this.peopleSearch.clear();
    this.pendingMember = null;
    const epoch = ++this.epoch;
    const priorPage = this.snapshot?.space.id === id ? this.page?.id : undefined;
    const priorConversation = this.conversation?.id;
    this.historyEpoch++;
    // Stop the personal pane immediately while an ACL invalidation is revalidated.
    this.conversation = null;
    this.conversationHistory.clear();
    this.messages = [];
    this.hits = [];
    this.loading = true;
    if (!revalidate) {
      this.error = "";
      this.clearDraft();
      this.pendingMember = null;
      this.notesOpen = false;
      this.membersOpen = false;
    }
    try {
      const snapshot = await this.rpc<SpaceSnapshot>("get", { spaceId: id });
      if (epoch !== this.epoch) {
        return;
      }
      // The server is authoritative; narrow again before rendering user-specific tabs.
      const conversations: SpaceConversation[] = [];
      for (const conversation of snapshot.conversations ?? []) {
        if (conversation.ownerId === snapshot.currentUserId) {
          conversations.push({
            ...conversation,
            canWrite: conversation.canWrite && snapshot.space.role !== "viewer",
          });
        }
      }
      snapshot.conversations = conversations;
      this.snapshot = snapshot;
      const pageId = priorPage ?? new URL(location.href).searchParams.get("page");
      this.page = snapshot.pages.find((page) => page.id === pageId) ?? null;
      if (snapshot.space.role === "viewer" || (this.editing && this.editing.id !== this.page?.id)) {
        this.clearDraft();
      }
      if (this.page) {
        const url = new URL(location.href);
        this.historyAnchor = url.searchParams.get("message") ?? "";
        this.expandAncestors(this.page);
        const requested = priorConversation ?? url.searchParams.get("conversation");
        this.conversation =
          (snapshot.conversations ?? []).find(
            (item) => item.pageId === this.page?.id && item.id === requested,
          ) ?? null;
        await this.loadHistory();
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.clearSensitive();
        this.error = spaceGatewayErrorMessage(error);
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
      }
    }
  }
  private selectPage(page: SpacePage, messageId = "") {
    if (this.editing || this.creating) {
      this.notice = t("finishEditing");
      return;
    }
    this.page = page;
    this.expandAncestors(page);
    this.conversationHistory.clear();
    this.conversation = messageId
      ? null
      : ((this.snapshot?.conversations ?? []).find((item) => item.pageId === page.id) ?? null);
    this.navigationOpen = false;
    this.notesOpen = false;
    this.membersOpen = false;
    this.followConversation = true;
    this.historyAnchor = messageId;
    this.messages = [];
    this.hits = [];
    const url = new URL(location.href);
    url.searchParams.set("space", page.spaceId);
    url.searchParams.set("page", page.id);
    url.searchParams.set("conversation", this.conversation?.id ?? "shared");
    if (messageId) {
      url.searchParams.set("message", messageId);
    } else {
      url.searchParams.delete("message");
    }
    history.replaceState(null, "", url);
    void this.loadHistory();
  }
  private expandAncestors(page: SpacePage) {
    const expanded = new Set(this.expandedPages);
    let parentId = page.parentId;
    while (parentId && !expanded.has(parentId)) {
      expanded.add(parentId);
      parentId = this.snapshot?.pages.find((item) => item.id === parentId)?.parentId ?? null;
    }
    this.expandedPages = expanded;
  }
  private selectConversation(conversation: SpaceConversation | null) {
    this.historyEpoch++;
    this.conversation = conversation;
    this.conversationHistory.clear();
    this.messages = [];
    this.historyAnchor = "";
    const url = new URL(location.href);
    url.searchParams.set("conversation", conversation?.id ?? "shared");
    url.searchParams.delete("message");
    history.replaceState(null, "", url);
    void this.loadHistory();
  }
  private scheduleHistory() {
    clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => void this.loadHistory(), 200);
  }
  private async loadHistory(older = false) {
    if (!this.page || !this.snapshot || (older && this.conversationHistory.loading)) {
      return;
    }
    const page = this.page;
    const conversation = this.conversation;
    const epoch = ++this.historyEpoch;
    if (older) {
      this.error = "";
    }
    // The canonical pane owns owner history, streaming and tool state.
    if (conversation?.canWrite) {
      return;
    }
    try {
      if (conversation) {
        await this.conversationHistory.load(
          (params) =>
            this.rpc("conversation.history", {
              spaceId: page.spaceId,
              conversationId: conversation.id,
              ...params,
            }),
          older,
        );
        return;
      }
      const value = await this.rpc<{ messages: SpaceMessage[] }>("chat.history", {
        spaceId: page.spaceId,
        pageId: page.id,
        ...(this.historyAnchor ? { messageId: this.historyAnchor } : {}),
      });
      if (epoch === this.historyEpoch && this.page?.id === page.id && !this.conversation) {
        this.messages = value.messages;
      }
    } catch (error) {
      if (epoch === this.historyEpoch) {
        if (!older) {
          this.messages = [];
          this.conversationHistory.clear();
        }
        this.error = spaceGatewayErrorMessage(error);
      }
    }
  }
  private async action(run: () => Promise<void>) {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.error = "";
    this.notice = "";
    try {
      await run();
    } catch (error) {
      this.error = spaceGatewayErrorMessage(error);
    } finally {
      this.busy = false;
    }
  }
  private openCreate(kind: "space" | "page" | "conversation", parentId?: string) {
    this.editing = null;
    this.navigationOpen = false;
    this.membersOpen = false;
    this.notesOpen = false;
    this.newParentId = kind === "page" ? parentId : undefined;
    this.creating = kind;
    this.draftTitle = kind === "conversation" ? t("newConversation") : "";
    this.body = "";
    this.createRequestId = crypto.randomUUID();
    this.notice = "";
    void this.updateComplete.then(() =>
      this.querySelector<HTMLInputElement>("[data-title]")?.focus(),
    );
  }
  private clearDraft() {
    this.editing = null;
    this.creating = null;
    this.draftTitle = "";
    this.body = "";
  }
  private cancelEdit() {
    this.clearDraft();
    this.pendingMember = null;
    this.notice = "";
    void this.updateComplete.then(() =>
      this.querySelector<HTMLButtonElement>("[data-new-page]")?.focus(),
    );
  }
  private save() {
    if (this.creating === "conversation") {
      void this.createConversation(this.draftTitle);
      return;
    }
    void this.action(async () => {
      if (this.creating === "space") {
        const space = await this.rpc<Space>("create", {
          name: this.draftTitle,
          requestId: this.createRequestId,
        });
        this.creating = null;
        await this.refresh();
        await this.selectSpace(space.id);
        return;
      }
      if (!this.snapshot) {
        return;
      }
      let page: SpacePage;
      if (this.creating === "page") {
        page = await this.rpc<SpacePage>("page.create", {
          spaceId: this.snapshot.space.id,
          ...(this.newParentId ? { parentId: this.newParentId } : {}),
          title: this.draftTitle,
          body: this.body,
          requestId: this.createRequestId,
        });
      } else if (this.editing) {
        page = await this.rpc<SpacePage>("page.save", {
          spaceId: this.editing.spaceId,
          pageId: this.editing.id,
          title: this.draftTitle,
          body: this.body,
          expectedRevision: this.editing.revision,
        });
      } else {
        return;
      }
      this.creating = null;
      this.editing = null;
      await this.selectSpace(page.spaceId);
      this.selectPage(page);
      this.notice = t("saved");
    });
  }
  private async createConversation(title = t("newConversation")): Promise<string | null> {
    const page = this.page;
    if (this.busy || !page || !this.snapshot || this.snapshot.space.role === "viewer") {
      return null;
    }
    const epoch = this.epoch;
    this.busy = true;
    this.error = "";
    this.notice = "";
    try {
      const conversation = await this.rpc<SpaceConversation>("conversation.create", {
        spaceId: page.spaceId,
        pageId: page.id,
        title,
        requestId: this.createRequestId,
      });
      if (epoch !== this.epoch || this.page?.id !== page.id || !this.snapshot) {
        return null;
      }
      if (conversation.ownerId !== this.snapshot.currentUserId || !conversation.canWrite) {
        throw new Error(t("lostAccess"));
      }
      this.snapshot = {
        ...this.snapshot,
        conversations: [
          ...(this.snapshot.conversations ?? []).filter((item) => item.id !== conversation.id),
          conversation,
        ],
      };
      this.creating = null;
      this.createRequestId = crypto.randomUUID();
      this.selectConversation(conversation);
      return conversation.sessionKey;
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = spaceGatewayErrorMessage(error);
      }
      return null;
    } finally {
      this.busy = false;
    }
  }
  private search() {
    void this.action(async () => {
      if (!this.snapshot || !this.query.trim()) {
        return;
      }
      const epoch = this.epoch;
      const result = await this.rpc<{ results: SpaceSearchHit[]; indexing?: boolean }>("search", {
        spaceId: this.snapshot.space.id,
        query: this.query,
      });
      if (epoch === this.epoch) {
        this.hits = result.results;
        this.notice = result.indexing ? t("indexing") : this.hits.length ? "" : t("noResults");
      }
    });
  }
  private get canManageMembers() {
    return this.snapshot?.space.role === "owner" && !this.loading && this.gatewayConnected;
  }
  private findPerson(query: string, immediate = false) {
    const space = this.snapshot?.space;
    this.pendingMember = null;
    if (!space || !this.canManageMembers) {
      this.peopleSearch.clear();
      return;
    }
    this.peopleSearch.search(
      query,
      (search) => this.rpc("people", { spaceId: space.id, query: search }),
      immediate,
    );
  }
  private changeMember() {
    void this.action(async () => {
      if (!this.snapshot || !this.canManageMembers || !this.pendingMember) {
        return;
      }
      const { userId, role } = this.pendingMember;
      await this.rpc(role ? "member.set" : "member.remove", {
        spaceId: this.snapshot.space.id,
        userId,
        ...(role ? { role } : {}),
        expectedRevision: this.snapshot.space.revision,
      });
      this.pendingMember = null;
      this.peopleSearch.clear();
      await this.refresh(true);
    });
  }
  private togglePanel(panel: "notes" | "members") {
    if (this.editing || this.creating) {
      this.notice = t("finishEditing");
      return;
    }
    this.peopleSearch.clear();
    const wasOpen = panel === "notes" ? this.notesOpen : this.membersOpen;
    this.notesOpen = panel === "notes" && !wasOpen;
    this.membersOpen = panel === "members" && !wasOpen;
    if (!this.membersOpen) {
      this.pendingMember = null;
    }
    this.navigationOpen = false;
    if (!wasOpen) {
      void this.updateComplete.then(() =>
        this.querySelector<HTMLButtonElement>(".pc-space-panel-header button")?.focus(),
      );
    }
  }
  private closePanel() {
    this.peopleSearch.clear();
    const members = this.membersOpen;
    if (this.editing || this.creating) {
      this.cancelEdit();
    }
    this.notesOpen = false;
    this.membersOpen = false;
    this.pendingMember = null;
    void this.updateComplete.then(() =>
      this.querySelector<HTMLButtonElement>(
        members ? ".pc-space-members-trigger" : ".pc-space-notes-trigger",
      )?.focus(),
    );
  }
  override render() {
    return renderSpacesView({
      spaces: this.spaces,
      snapshot: this.snapshot,
      page: this.page,
      messages: this.messages,
      error: this.error,
      notice: this.notice,
      historyAnchor: this.historyAnchor,
      loading: this.loading,
      busy: this.busy,
      navigationOpen: this.navigationOpen,
      panel: this.membersOpen ? "members" : this.notesOpen ? "notes" : null,
      editor:
        this.creating || this.editing
          ? {
              kind: this.creating ?? "edit",
              title: this.draftTitle,
              body: this.body,
              revision: this.editing?.revision,
            }
          : null,
      conversation: this.conversation,
      conversationView: renderSpaceConversation({
        conversation: this.conversation,
        messages: this.conversationHistory.messages,
        loading: this.loading || this.conversationHistory.loading,
        hasMore: this.conversationHistory.pagination.hasMore,
        onLoadOlder: () => void this.loadHistory(true),
        onCreate: () => this.createConversation(),
        onSessionChange: (key) => {
          const next = this.snapshot?.conversations.find(
            (item) => item.sessionKey === key && item.pageId === this.page?.id,
          );
          if (next && next.id !== this.conversation?.id) {
            this.selectConversation(next);
          }
        },
      }),
      expandedPages: this.expandedPages,
      query: this.query,
      hits: this.hits,
      membersView: this.membersOpen
        ? renderSpaceMembers({
            owner: this.canManageMembers,
            members: this.snapshot?.members ?? [],
            busy: this.busy,
            search: this.peopleSearch,
            pending: this.pendingMember,
            onAccount: (value, immediate) => this.findPerson(value, immediate),
            onPending: (value) => {
              this.pendingMember = value;
              this.peopleSearch.clear();
            },
            onConfirm: () => this.changeMember(),
          })
        : nothing,
      onSelectSpace: (id) => void this.selectSpace(id),
      onSelectPage: (page, messageId) => this.selectPage(page, messageId),
      onCreate: (kind, parentId) => this.openCreate(kind, parentId),
      onRefresh: () => void this.refresh(Boolean(this.editing || this.creating)),
      onSearch: () => this.search(),
      onQuery: (value) => {
        this.query = value;
      },
      onSelectConversation: (conversation) => this.selectConversation(conversation),
      onTogglePage: (id) => {
        const expanded = new Set(this.expandedPages);
        if (expanded.has(id)) {
          expanded.delete(id);
        } else {
          expanded.add(id);
        }
        this.expandedPages = expanded;
      },
      onPanel: (panel) => this.togglePanel(panel),
      onClosePanel: () => this.closePanel(),
      onToggleNavigation: () => {
        this.navigationOpen = !this.navigationOpen;
        if (this.navigationOpen) {
          this.notesOpen = false;
          this.membersOpen = false;
          this.pendingMember = null;
        }
      },
      onEdit: () => {
        if (this.page) {
          this.editing = this.page;
          this.draftTitle = this.page.title;
          this.body = this.page.body;
        }
      },
      onUseSavedRevision: (page) => {
        if (
          this.busy ||
          this.loading ||
          this.editing?.id !== page.id ||
          this.snapshot?.space.role === "viewer" ||
          this.page !== page
        ) {
          return;
        }
        this.editing = page;
        this.draftTitle = page.title;
        this.body = page.body;
        this.error = "";
        this.notice = t("draftReplaced");
      },
      onCancel: () => this.cancelEdit(),
      onSave: () => this.save(),
      onTitle: (value) => {
        this.draftTitle = value;
        this.createRequestId = crypto.randomUUID();
      },
      onBody: (value) => {
        this.body = value;
        this.createRequestId = crypto.randomUUID();
      },
      onLatest: () => {
        this.historyAnchor = "";
        this.followConversation = true;
        void this.loadHistory();
      },
      onHistoryScroll: (event) => {
        const target = event.currentTarget as HTMLElement;
        this.followConversation = target.scrollHeight - target.scrollTop - target.clientHeight < 96;
      },
    });
  }
}
if (!customElements.get("platformclaw-spaces-page")) {
  customElements.define("platformclaw-spaces-page", PlatformClawSpacesPage);
}

export async function loadSpacePage() {
  await loadPlatformClawLocale();
  return {
    header: false,
    render: () => html`<platformclaw-spaces-page></platformclaw-spaces-page>`,
  };
}
