import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import type {
  Space,
  SpacePage,
  SpaceMember,
  SpaceRole,
} from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import type { SpaceMessage } from "../../../packages/platformclaw-control-plane/src/space-service.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT } from "./i18n.ts";
import { renderSpaceMembers } from "./space-members-view.ts";
import { renderSpacesView, type SpaceSnapshot, type SpaceSearchHit } from "./spaces-view.ts";
import "./spaces.css";
const t = (key: string) => platformClawT(`platformClaw.spaces.${key}`);
const RPC = "platformclaw.spaces.";
export class PlatformClawSpacesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @state() private spaces: Space[] = [];
  @state() private snapshot: SpaceSnapshot | null = null;
  @state() private page: SpacePage | null = null;
  @state() private messages: SpaceMessage[] = [];
  @state() private error = "";
  @state() private notice = "";
  @state() private streaming = "";
  @state() private historyAnchor = "";
  @state() private loading = false;
  @state() private busy = false;
  // Keep the draft's original revision when membership revalidation refreshes the page.
  @state() private editing: SpacePage | null = null;
  @state() private membersOpen = false;
  @state() private notesOpen = false;
  @state() private navigationOpen = false;
  private followConversation = true;
  @state() private creating: "space" | "page" | null = null;
  @state() private draftTitle = "";
  @state() private body = "";
  private newParentId: string | undefined;
  @state() private draft = "";
  @state() private query = "";
  @state() private hits: SpaceSearchHit[] = [];
  @state() private account = "";
  @state() private candidates: Array<Omit<SpaceMember, "role">> = [];
  @state() private pendingMember: { userId: string; label: string; role: SpaceRole | null } | null =
    null;
  private epoch = 0;
  private historyEpoch = 0;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeState: (() => void) | undefined;
  private historyTimer: ReturnType<typeof setTimeout> | undefined;
  private draftRequestId = crypto.randomUUID();
  private createRequestId = crypto.randomUUID();
  private gatewayClient: unknown;
  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }
  override disconnectedCallback() {
    this.epoch++;
    this.historyEpoch++;
    this.unsubscribe?.();
    this.unsubscribeState?.();
    clearTimeout(this.historyTimer);
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues) {
    if (changed.has("messages") || changed.has("streaming") || changed.has("page")) {
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
            const update = event.payload as { state?: string; text?: string };
            if (update.state === "delta") {
              this.streaming = update.text ?? this.streaming;
            } else {
              this.streaming = "";
              this.scheduleHistory();
            }
            if (update.state === "error") {
              this.error = t("runFailed");
              this.notice = "";
            }
            if (update.state === "final") {
              this.notice = "";
            }
          }
        }
      });
      if (gateway.snapshot.phase === "connected") {
        void this.refresh();
      }
    }
    if (gateway.snapshot.phase !== "connected") {
      if (this.messages.length) {
        this.messages = [];
      }
      if (this.hits.length) {
        this.hits = [];
      }
      if (this.streaming) {
        this.streaming = "";
      }
      this.historyEpoch++;
      clearTimeout(this.historyTimer);
    }
  }
  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const gateway = this.context.gateway.snapshot;
    if (gateway.phase !== "connected" || !gateway.client) {
      throw new Error(t("disconnected"));
    }
    const client = gateway.client;
    const result = await client.request<T>(RPC + method, params);
    if (
      client !== this.context.gateway.snapshot.client ||
      this.context.gateway.snapshot.phase !== "connected"
    ) {
      throw new Error(t("disconnected"));
    }
    return result;
  }
  private message(error: unknown) {
    return error instanceof Error ? error.message : t("failed");
  }
  private clearSensitive() {
    this.snapshot = null;
    this.page = null;
    this.messages = [];
    this.streaming = "";
    this.hits = [];
    this.editing = null;
    this.creating = null;
    this.draftTitle = "";
    this.body = "";
    this.draft = "";
    this.membersOpen = false;
    this.notesOpen = false;
    this.candidates = [];
    this.pendingMember = null;
  }
  private async refresh(revalidate = false) {
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
        this.error = this.message(error);
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
      }
    }
  }
  private async selectSpace(id: string, revalidate = false) {
    const epoch = ++this.epoch;
    const priorPage = this.snapshot?.space.id === id ? this.page?.id : undefined;
    this.historyEpoch++;
    this.messages = [];
    this.hits = [];
    this.loading = true;
    if (!revalidate) {
      this.error = "";
      this.editing = null;
      this.creating = null;
      this.draftTitle = "";
      this.body = "";
      this.pendingMember = null;
      this.draft = "";
      this.notesOpen = false;
      this.membersOpen = false;
    }
    try {
      const snapshot = await this.rpc<SpaceSnapshot>("get", { spaceId: id });
      if (epoch !== this.epoch) {
        return;
      }
      this.snapshot = snapshot;
      const pageId = priorPage ?? new URL(location.href).searchParams.get("page");
      this.page = snapshot.pages.find((page) => page.id === pageId) ?? null;
      if (snapshot.space.role === "viewer" || (this.editing && this.editing.id !== this.page?.id)) {
        this.editing = null;
        this.creating = null;
        this.draftTitle = "";
        this.body = "";
        this.draft = "";
      }
      if (this.page) {
        this.historyAnchor = new URL(location.href).searchParams.get("message") ?? "";
        await this.loadHistory();
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.clearSensitive();
        this.error = this.message(error);
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
    this.navigationOpen = false;
    this.notesOpen = false;
    this.membersOpen = false;
    this.followConversation = true;
    this.historyAnchor = messageId;
    this.streaming = "";
    this.messages = [];
    this.draft = "";
    this.hits = [];
    this.draftRequestId = crypto.randomUUID();
    const url = new URL(location.href);
    url.searchParams.set("space", page.spaceId);
    url.searchParams.set("page", page.id);
    if (messageId) {
      url.searchParams.set("message", messageId);
    } else {
      url.searchParams.delete("message");
    }
    history.replaceState(null, "", url);
    void this.loadHistory();
  }
  private scheduleHistory() {
    clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => void this.loadHistory(), 200);
  }
  private async loadHistory() {
    if (!this.page || !this.snapshot) {
      return;
    }
    const page = this.page;
    const epoch = ++this.historyEpoch;
    try {
      const value = await this.rpc<{ messages: SpaceMessage[] }>("chat.history", {
        spaceId: page.spaceId,
        pageId: page.id,
        ...(this.historyAnchor ? { messageId: this.historyAnchor } : {}),
      });
      if (epoch === this.historyEpoch && this.page?.id === page.id) {
        this.messages = value.messages;
      }
    } catch (error) {
      if (epoch === this.historyEpoch) {
        this.messages = [];
        this.error = this.message(error);
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
      this.error = this.message(error);
    } finally {
      this.busy = false;
    }
  }
  private openCreate(kind: "space" | "page", parentId?: string) {
    this.editing = null;
    this.navigationOpen = false;
    this.membersOpen = false;
    this.notesOpen = false;
    this.newParentId = kind === "page" ? parentId : undefined;
    this.creating = kind;
    this.draftTitle = "";
    this.body = "";
    this.createRequestId = crypto.randomUUID();
    this.notice = "";
    void this.updateComplete.then(() =>
      this.querySelector<HTMLInputElement>("[data-title]")?.focus(),
    );
  }
  private cancelEdit() {
    this.creating = null;
    this.editing = null;
    this.draftTitle = "";
    this.body = "";
    this.pendingMember = null;
    this.notice = "";
    void this.updateComplete.then(() =>
      this.querySelector<HTMLButtonElement>("[data-new-page]")?.focus(),
    );
  }
  private save() {
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
  private send() {
    void this.action(async () => {
      if (!this.page || !this.draft.trim()) {
        return;
      }
      await this.rpc("chat.send", {
        spaceId: this.page.spaceId,
        pageId: this.page.id,
        message: this.draft,
        requestId: this.draftRequestId,
      });
      this.draft = "";
      this.draftRequestId = crypto.randomUUID();
      this.notice = this.error ? "" : t("accepted");
      await this.loadHistory();
    });
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
  private findPerson() {
    void this.action(async () => {
      if (this.snapshot) {
        this.candidates = await this.rpc("people", {
          spaceId: this.snapshot.space.id,
          query: this.account,
        });
        if (!this.candidates.length) {
          this.notice = t("noPerson");
        }
      }
    });
  }
  private changeMember() {
    void this.action(async () => {
      if (!this.snapshot || !this.pendingMember) {
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
      this.candidates = [];
      await this.refresh(true);
    });
  }
  private togglePanel(panel: "notes" | "members") {
    if (this.editing || this.creating) {
      this.notice = t("finishEditing");
      return;
    }
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
      streaming: this.streaming,
      historyAnchor: this.historyAnchor,
      loading: this.loading,
      busy: this.busy,
      navigationOpen: this.navigationOpen,
      panel: this.membersOpen ? "members" : this.notesOpen ? "notes" : null,
      editor:
        this.creating || this.editing
          ? { kind: this.creating ?? "edit", title: this.draftTitle, body: this.body }
          : null,
      draft: this.draft,
      query: this.query,
      hits: this.hits,
      membersView: this.membersOpen ? this.renderMembers() : nothing,
      onSelectSpace: (id) => {
        void this.selectSpace(id);
      },
      onSelectPage: (page, messageId) => this.selectPage(page, messageId),
      onCreate: (kind, parentId) => this.openCreate(kind, parentId),
      onRefresh: () => {
        void this.refresh(Boolean(this.editing || this.creating));
      },
      onSearch: () => this.search(),
      onQuery: (value) => {
        this.query = value;
      },
      onDraft: (value) => {
        this.draft = value;
        this.draftRequestId = crypto.randomUUID();
      },
      onSend: () => this.send(),
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
  private renderMembers() {
    return renderSpaceMembers({
      owner: this.snapshot?.space.role === "owner",
      members: this.snapshot?.members ?? [],
      busy: this.busy,
      account: this.account,
      candidates: this.candidates,
      pending: this.pendingMember,
      onAccount: (value) => {
        this.account = value;
        this.candidates = [];
      },
      onPending: (value) => {
        this.pendingMember = value;
      },
      onFind: () => this.findPerson(),
      onConfirm: () => this.changeMember(),
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
