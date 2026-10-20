import { consume } from "@lit/context";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  Space,
  SpacePage,
  SpaceRole,
  SpaceConversation,
} from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT } from "./i18n.ts";
import {
  SpaceConversationHistoryState,
  SpacePageHistoryState,
  scrollSpacePageHistory,
} from "./space-conversation-history.ts";
import {
  spaceSelectionUrl,
  replaceSpaceSelection,
  spaceRouteMatchesSelection,
} from "./space-conversation-route.ts";
import { SpaceGatewayLifetime } from "./space-gateway-lifetime.ts";
import {
  canRetainSpaceDraftAfterFailure,
  requestSpaceGateway,
  spaceGatewayErrorMessage,
  normalizeSpaceSnapshot,
  upsertSpaceConversation,
  type SpaceSnapshot,
} from "./space-gateway-request.ts";
import { SpaceManagementState } from "./space-management.ts";
import { SpacePageEditor } from "./space-page-editor.ts";
import { SpacePeopleSearch } from "./space-people-search.ts";
import { SpaceQaPostsState } from "./space-qa-posts.ts";
import "../styles/chat.css";
import "../pages/chat/chat-pane.ts";
import {
  renderSpacesView,
  expandSpacePageAncestors,
  focusSpaceViewTarget,
  toggleSpacePageExpansion,
  type SpaceSearchHit,
} from "./spaces-view.ts";
import "./spaces.css";
const t = (key: string) => platformClawT(`platformClaw.spaces.${key}`);
export class PlatformClawSpacesPage extends OpenClawLightDomElement {
  @property({ attribute: false }) routeSearch: string | undefined;
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  private readonly management = new SpaceManagementState(() => this.requestUpdate());
  @state() private spaces: Space[] = [];
  @state() private snapshot: SpaceSnapshot | null = null;
  @state() private page: SpacePage | null = null;
  @state() private conversation: SpaceConversation | null = null;
  @state() private sharedTab: "qa" | "notes" = "qa";
  @state() private postAnchor = "";
  private readonly qaPosts = new SpaceQaPostsState(() => this.requestUpdate("qaPosts", undefined));
  private readonly conversationHistory = new SpaceConversationHistoryState(() =>
    this.requestUpdate(),
  );
  private readonly history = new SpacePageHistoryState({
    source: () => ({
      page: this.page,
      conversation: this.conversation,
      authorized: this.snapshot !== null,
      tab: this.sharedTab,
      anchor: this.historyAnchor,
      postAnchor: this.postAnchor,
    }),
    conversation: this.conversationHistory,
    sharedPosts: this.qaPosts,
    request: (method, params) => this.rpc(method, params),
    changed: () => this.requestUpdate("history", undefined),
    onError: (error) => {
      this.error = spaceGatewayErrorMessage(error);
    },
  });
  @state() private expandedPages = new Set<string>();
  @state() private error = "";
  @state() private notice = "";
  @state() private historyAnchor = "";
  @state() private loading = false;
  @state() private busy = false;
  private readonly editor = new SpacePageEditor(() => this.requestUpdate());
  @state() private membersOpen = false;
  @state() private navigationOpen = false;
  private followConversation = true;
  @state() private query = "";
  @state() private hits: SpaceSearchHit[] = [];
  private readonly peopleSearch = new SpacePeopleSearch(() => this.requestUpdate());
  @state() private pendingMember: { userId: string; label: string; role: SpaceRole | null } | null =
    null;
  private epoch = 0;
  private readonly gatewayLifetime = new SpaceGatewayLifetime(
    () => this.requestUpdate(),
    (event) => this.handleGatewayEvent(event),
  );
  private managementInvalidated = false;
  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }
  override disconnectedCallback() {
    this.peopleSearch.clear();
    this.management.clear();
    this.editor.clear();
    this.epoch++;
    this.history.clear();
    this.gatewayLifetime.dispose();
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues) {
    scrollSpacePageHistory(
      this,
      changed,
      this.historyAnchor || this.postAnchor,
      this.followConversation,
    );
    if (!this.context?.gateway) {
      return;
    }
    const routeChanged =
      changed.has("routeSearch") &&
      !spaceRouteMatchesSelection(
        this.routeSearch,
        this.snapshot?.space.id,
        this.page?.id,
        this.conversation?.id,
        this.historyAnchor,
        this.sharedTab,
        this.postAnchor,
      );
    if (routeChanged) {
      // Back/forward must retire the old selection even while disconnected;
      // reconnect may otherwise prefer its stale snapshot over the new URL.
      this.epoch++;
      this.loading = false;
      this.clearSensitive();
    }
    const transition = this.gatewayLifetime.update(this.context.gateway);
    if (transition === "identity") {
      this.epoch++;
      this.clearSensitive();
      this.spaces = [];
      if (this.gatewayLifetime.connected) {
        void this.refresh();
      }
    } else if (transition === "reconnected") {
      void this.refresh(true);
    } else if (routeChanged && this.gatewayLifetime.connected) {
      void this.refresh();
    }
    if (transition === "disconnected") {
      this.epoch++;
      this.loading = false;
      this.suspendDraft();
      this.clearSensitive(false, true);
    }
  }
  private handleGatewayEvent(event: GatewayEventFrame) {
    if (event.event === "platformclaw.spaces.invalidated") {
      if (this.management.busy) {
        this.managementInvalidated = true;
        this.epoch++;
        this.loading = false;
        this.clearSensitive(true);
      } else {
        void this.refresh(true);
      }
    }
    if (event.event === "platformclaw.space.changed") {
      this.history.changed(event.payload);
    }
  }
  private rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return requestSpaceGateway<T>(() => this.context, method, params);
  }
  private suspendDraft() {
    const selection = new URL(location.href);
    this.editor.suspend(
      this.snapshot?.currentUserId ?? this.gatewayLifetime.userId,
      selection.pathname + selection.search,
      selection.searchParams.get("page"),
    );
  }
  private clearSensitive(keepConfirmation = false, keepDraft = false) {
    // Hide revoked content immediately, but keep an in-flight action available for its acknowledgment.
    if (!keepConfirmation) {
      this.management.clear();
    }
    this.snapshot = null;
    this.page = null;
    this.conversation = null;
    this.history.clear();
    this.hits = [];
    this.query = "";
    this.historyAnchor = "";
    this.postAnchor = "";
    this.sharedTab = "qa";
    if (!keepDraft) {
      this.editor.clear();
    }
    this.membersOpen = false;
    this.peopleSearch.clear();
    this.pendingMember = null;
  }
  private async refresh(revalidate = false, keepConfirmation = false) {
    if (!this.gatewayLifetime.connected) {
      return;
    }
    this.peopleSearch.clear();
    this.pendingMember = null;
    const epoch = ++this.epoch;
    this.loading = true;
    if (!revalidate || this.editor.suspended) {
      this.error = "";
    }
    if (revalidate && !this.editor.suspended) {
      this.suspendDraft();
    }
    const selected = this.snapshot?.space.id ?? new URL(location.href).searchParams.get("space");
    try {
      const spaces = await this.rpc<Space[]>("list");
      if (epoch !== this.epoch) {
        return;
      }
      this.spaces = spaces;
      const selectedSpace = spaces.find((space) => space.id === selected);
      if (selectedSpace?.deleting || selectedSpace?.leaving) {
        this.clearSensitive(keepConfirmation);
        this.notice = t(selectedSpace.deleting ? "deletionPending" : "leavePending");
      } else if (selectedSpace) {
        await this.selectSpace(selectedSpace.id, revalidate);
      } else if (selected) {
        this.clearSensitive(keepConfirmation);
        this.error = t("lostAccess");
      } else if (this.editor.creating === "space") {
        this.editor.resume(this.gatewayLifetime.userId, location.pathname + location.search);
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.clearSensitive(
          keepConfirmation,
          this.editor.suspended && canRetainSpaceDraftAfterFailure(error),
        );
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
    const priorConversation = this.snapshot?.space.id === id ? this.conversation?.id : undefined;
    const url = spaceSelectionUrl({ spaceId: id });
    if (revalidate && !this.editor.suspended) {
      this.suspendDraft();
    }
    // Stop the personal pane immediately while an ACL invalidation is revalidated.
    this.conversation = null;
    this.history.clear();
    this.snapshot = null;
    this.page = null;
    this.hits = [];
    this.loading = true;
    if (!revalidate) {
      this.management.clear();
      this.error = "";
      this.editor.clear();
      this.membersOpen = false;
    }
    try {
      const snapshot = normalizeSpaceSnapshot(
        await this.rpc<SpaceSnapshot>("get", { spaceId: id }),
      );
      if (epoch !== this.epoch) {
        return;
      }
      this.management.revalidate(snapshot.space, snapshot.conversations);
      this.snapshot = snapshot;
      const pageId = priorPage ?? url.searchParams.get("page");
      this.page = snapshot.pages.find((page) => page.id === pageId) ?? null;
      this.editor.revalidate(snapshot, this.page, location.pathname + location.search);
      replaceSpaceSelection(this.context, url);
      if (this.page) {
        this.historyAnchor = url.searchParams.get("message") ?? "";
        this.sharedTab = url.searchParams.get("tab") === "notes" ? "notes" : "qa";
        this.postAnchor = this.sharedTab === "qa" ? (url.searchParams.get("post") ?? "") : "";
        this.expandedPages = expandSpacePageAncestors(
          this.expandedPages,
          this.page,
          snapshot.pages,
        );
        const requested = priorConversation ?? url.searchParams.get("conversation");
        this.conversation = url.searchParams.has("tab")
          ? null
          : ((snapshot.conversations ?? []).find(
              (item) => item.pageId === this.page?.id && item.id === requested,
            ) ?? null);
        await this.loadHistory();
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.clearSensitive(false, this.editor.suspended && canRetainSpaceDraftAfterFailure(error));
        this.error = spaceGatewayErrorMessage(error);
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
      }
    }
  }
  private selectPage(page: SpacePage, messageId = "", postId = "", tab: "qa" | "notes" = "qa") {
    if (this.editor.active) {
      this.notice = t("finishEditing");
      return;
    }
    this.management.clear();
    this.epoch++;
    this.loading = false;
    this.page = page;
    this.expandedPages = expandSpacePageAncestors(
      this.expandedPages,
      page,
      this.snapshot?.pages ?? [],
    );
    this.history.clear();
    this.sharedTab = tab;
    this.postAnchor = postId;
    this.conversation =
      messageId || postId || tab === "notes"
        ? null
        : ((this.snapshot?.conversations ?? []).find((item) => item.pageId === page.id) ?? null);
    this.navigationOpen = false;
    this.membersOpen = false;
    this.followConversation = true;
    this.historyAnchor = messageId;
    this.hits = [];
    replaceSpaceSelection(
      this.context,
      spaceSelectionUrl({
        page,
        conversation: this.conversation,
        messageId,
        ...(postId || tab === "notes" ? { tab, postId } : {}),
      }),
    );
    void this.loadHistory();
  }
  private selectConversation(conversation: SpaceConversation | null, tab: "qa" | "notes" = "qa") {
    if (this.editor.active) {
      return;
    }
    this.management.clear();
    this.epoch++;
    this.loading = false;
    this.conversation = conversation;
    this.sharedTab = tab;
    this.postAnchor = "";
    this.history.clear();
    this.historyAnchor = "";
    replaceSpaceSelection(
      this.context,
      spaceSelectionUrl(conversation ? { conversation } : { tab }),
    );
    void this.loadHistory();
  }
  private loadHistory(older = false) {
    if (older) {
      this.error = "";
    }
    return this.history.load(older);
  }
  private async action<T>(run: () => Promise<T>, isCurrent = () => true): Promise<T | null> {
    if (this.busy) {
      return null;
    }
    this.busy = true;
    this.error = "";
    this.notice = "";
    try {
      return await run();
    } catch (error) {
      if (isCurrent()) {
        this.error = spaceGatewayErrorMessage(error);
      }
      return null;
    } finally {
      this.busy = false;
    }
  }
  private openCreate(kind: "space" | "page" | "conversation", parentId?: string) {
    if (!this.gatewayLifetime.connected || this.loading || this.editor.suspended) {
      return;
    }
    this.navigationOpen = this.membersOpen = false;
    this.editor.open(kind, parentId);
    this.notice = "";
    focusSpaceViewTarget(this, "[data-title]");
  }
  private cancelEdit() {
    this.editor.clear();
    this.pendingMember = null;
    this.notice = "";
    focusSpaceViewTarget(this, "[data-new-page]");
  }
  private save() {
    if (!this.gatewayLifetime.connected || this.loading || this.editor.suspended) {
      return;
    }
    if (this.editor.creating === "conversation") {
      void this.createConversation(this.editor.title);
      return;
    }
    void this.action(async () => {
      const saved = await this.editor.save(this.snapshot?.space.id, (method, params) =>
        this.rpc(method, params),
      );
      if (saved?.kind === "space") {
        await this.refresh();
        await this.selectSpace(saved.space.id);
      } else if (saved?.kind === "page") {
        await this.selectSpace(saved.page.spaceId);
        this.selectPage(saved.page, "", "", "notes");
        this.notice = t("saved");
      }
    });
  }
  private async createConversation(title = t("newConversation")): Promise<string | null> {
    const page = this.page;
    if (
      this.busy ||
      this.editor.suspended ||
      !page ||
      !this.snapshot ||
      this.snapshot.space.role === "viewer"
    ) {
      return null;
    }
    const epoch = this.epoch;
    return this.action(
      async () => {
        const conversation = await this.rpc<SpaceConversation>("conversation.create", {
          spaceId: page.spaceId,
          pageId: page.id,
          title,
          requestId: this.editor.requestId,
        });
        if (epoch !== this.epoch || this.page?.id !== page.id || !this.snapshot) {
          return null;
        }
        if (conversation.ownerId !== this.snapshot.currentUserId || !conversation.canWrite) {
          throw new Error(t("lostAccess"));
        }
        this.snapshot = upsertSpaceConversation(this.snapshot, conversation);
        this.editor.creating = null;
        this.editor.requestId = crypto.randomUUID();
        this.selectConversation(conversation);
        return conversation.sessionKey;
      },
      () => epoch === this.epoch,
    );
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
    return this.snapshot?.space.role === "owner" && !this.loading && this.gatewayLifetime.connected;
  }
  private findPerson(query: string, immediate = false) {
    this.pendingMember = null;
    this.peopleSearch.searchSpace(
      this.canManageMembers ? this.snapshot?.space : undefined,
      query,
      (spaceId, search) => this.rpc("people", { spaceId, query: search }),
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
  private togglePanel() {
    if (this.editor.active) {
      this.notice = t("finishEditing");
      return;
    }
    this.peopleSearch.clear();
    const wasOpen = this.membersOpen;
    this.membersOpen = !wasOpen;
    if (!this.membersOpen) {
      this.pendingMember = null;
    }
    this.navigationOpen = false;
    if (!wasOpen) {
      focusSpaceViewTarget(this, ".pc-space-panel-header button");
    }
  }
  private closePanel() {
    this.peopleSearch.clear();
    const members = this.membersOpen;
    if (this.editor.active) {
      this.cancelEdit();
    }
    this.membersOpen = false;
    this.pendingMember = null;
    focusSpaceViewTarget(this, members ? ".pc-space-members-trigger" : 'wa-tab[panel="notes"]');
  }
  private openManagement(kind: "rename" | "delete" | "leave", space = this.snapshot?.space) {
    this.management.openFor(kind, {
      space,
      conversation: this.conversation,
      currentUserId: this.snapshot?.currentUserId,
      disabled: this.busy || this.loading || !this.gatewayLifetime.connected,
    });
  }
  private async submitManagement(title: string) {
    if (this.management.busy) {
      return;
    }
    this.managementInvalidated = false;
    const result = await this.management.submit(
      title,
      (method, params) => this.rpc(method, params),
      (action, conversation) => {
        if (action.kind === "rename" && conversation) {
          if (this.snapshot) {
            this.snapshot = upsertSpaceConversation(this.snapshot, conversation);
          }
          if (this.conversation?.id === conversation.id) {
            this.conversation = conversation;
          }
          this.notice = t("conversationRenamed");
        } else if (action.kind !== "rename") {
          this.spaces = this.spaces.filter((space) => space.id !== action.space.id);
          const url = new URL(location.href);
          if (
            this.snapshot?.space.id === action.space.id ||
            url.searchParams.get("space") === action.space.id
          ) {
            this.clearSensitive();
            replaceSpaceSelection(this.context, spaceSelectionUrl({ spaceId: null }));
          }
          this.notice = t(action.kind === "delete" ? "spaceDeleted" : "spaceLeft");
        }
      },
    );
    // Mutations invalidate access while their RPC is pending; revalidate once it settles.
    if (
      this.isConnected &&
      this.gatewayLifetime.connected &&
      (result === "completed" || this.managementInvalidated)
    ) {
      const error = this.management.error;
      this.managementInvalidated = false;
      await this.refresh(true, result === "failed" && this.management.pending?.kind === "leave");
      if (error && !this.management.pending) {
        this.error = error;
      }
    }
  }
  override render() {
    return renderSpacesView({
      titleAccessory: this.context?.renderPageHeaderAccessory?.("spaces"),
      spaces: this.spaces,
      snapshot: this.snapshot,
      page: this.page,
      messages: this.history.messages,
      error: this.error,
      notice: this.gatewayLifetime.connected ? this.notice : t("disconnected"),
      historyAnchor: this.historyAnchor,
      loading: this.loading,
      busy:
        this.busy ||
        this.management.busy ||
        !this.gatewayLifetime.connected ||
        this.editor.suspended,
      refreshDisabled:
        this.busy || this.management.busy || this.loading || !this.gatewayLifetime.connected,
      management: this.management,
      onSubmitManagement: (title) => void this.submitManagement(title),
      onRenameConversation: () => this.openManagement("rename"),
      onRetrySpace: (space) => this.openManagement(space.deleting ? "delete" : "leave", space),
      navigationOpen: this.navigationOpen,
      panel: this.membersOpen ? "members" : null,
      sharedTab: this.sharedTab,
      qaPosts: this.qaPosts,
      postAnchor: this.postAnchor,
      request: (method, params) => this.rpc(method, params),
      editor: this.editor.view,
      conversation: this.conversation,
      conversationHistory: this.conversationHistory,
      onLoadOlder: () => void this.loadHistory(true),
      onCreateConversation: () => this.createConversation(),
      onSessionChange: (key) => {
        const next = this.snapshot?.conversations.find(
          (item) => item.sessionKey === key && item.pageId === this.page?.id,
        );
        if (next && next.id !== this.conversation?.id) {
          this.selectConversation(next);
        }
      },
      expandedPages: this.expandedPages,
      query: this.query,
      hits: this.hits,
      canManageMembers: this.canManageMembers,
      membersBusy:
        this.busy || this.management.busy || this.loading || !this.gatewayLifetime.connected,
      peopleSearch: this.peopleSearch,
      pendingMember: this.pendingMember,
      onAccount: (value, immediate) => this.findPerson(value, immediate),
      onPendingMember: (value) => {
        this.pendingMember = value;
        this.peopleSearch.clear();
      },
      onConfirmMember: () => this.changeMember(),
      onLeaveSpace: () => this.openManagement("leave"),
      onDeleteSpace: () => this.openManagement("delete"),
      onSelectSpace: (id) => void this.selectSpace(id),
      onSelectPage: (page, messageId, postId, tab) => this.selectPage(page, messageId, postId, tab),
      onCreate: (kind, parentId) => this.openCreate(kind, parentId),
      onRefresh: () => void this.refresh(this.editor.active),
      onSearch: () => this.search(),
      onQuery: (value) => {
        this.query = value;
      },
      onSelectConversation: (conversation) => this.selectConversation(conversation),
      onSelectNotes: () => this.selectConversation(null, "notes"),
      onTogglePage: (id) => {
        this.expandedPages = toggleSpacePageExpansion(this.expandedPages, id);
      },
      onPanel: () => this.togglePanel(),
      onClosePanel: () => this.closePanel(),
      onToggleNavigation: () => {
        this.navigationOpen = !this.navigationOpen;
        if (this.navigationOpen) {
          this.membersOpen = false;
          this.pendingMember = null;
        }
      },
      onEdit: () => {
        if (this.page) {
          this.editor.edit(this.page);
        }
      },
      onUseSavedRevision: (page) => {
        const canEdit = !this.busy && !this.loading && this.snapshot?.space.role !== "viewer";
        if (this.editor.replaceSaved(page, this.page, canEdit)) {
          this.error = "";
          this.notice = t("draftReplaced");
        }
      },
      onCancel: () => this.cancelEdit(),
      onSave: () => this.save(),
      onTitle: (value) => this.editor.change("title", value),
      onBody: (value) => this.editor.change("body", value),
      onLatest: () => {
        this.historyAnchor = "";
        this.followConversation = true;
        void this.loadHistory();
      },
      onFollowConversation: (follow) => {
        this.followConversation = follow;
      },
    });
  }
}
if (!customElements.get("platformclaw-spaces-page")) {
  customElements.define("platformclaw-spaces-page", PlatformClawSpacesPage);
}
