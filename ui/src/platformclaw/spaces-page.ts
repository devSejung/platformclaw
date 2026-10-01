import { consume } from "@lit/context";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
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
import "./spaces.css";
const t = (key: string) => platformClawT(`platformClaw.spaces.${key}`);
const RPC = "platformclaw.spaces.";
type Snapshot = { space: Space; pages: SpacePage[]; members: SpaceMember[] };
type Hit = {
  spaceId: string;
  pageId: string;
  pageTitle: string;
  snippet: string;
  link: string;
  messageId?: string;
};
export class PlatformClawSpacesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @state() private spaces: Space[] = [];
  @state() private snapshot: Snapshot | null = null;
  @state() private page: SpacePage | null = null;
  @state() private messages: SpaceMessage[] = [];
  @state() private error = "";
  @state() private notice = "";
  @state() private streaming = "";
  @state() private historyAnchor = "";
  @state() private loading = false;
  @state() private busy = false;
  @state() private editing = false;
  @state() private membersOpen = false;
  @state() private creating: "space" | "page" | null = null;
  @state() private draftTitle = "";
  @state() private body = "";
  private newParentId: string | undefined;
  @state() private draft = "";
  @state() private query = "";
  @state() private hits: Hit[] = [];
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
  protected override updated(_changed: PropertyValues) {
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
      this.snapshot = null;
      this.page = null;
      this.messages = [];
      this.spaces = [];
      this.draft = "";
      this.hits = [];
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
              this.notice = t("runFailed");
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
    this.editing = false;
    this.body = "";
    this.draft = "";
    this.membersOpen = false;
    this.candidates = [];
    this.pendingMember = null;
  }
  private async refresh(revalidate = false) {
    const epoch = ++this.epoch;
    this.loading = true;
    this.error = "";
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
    this.error = "";
    if (!revalidate) {
      this.editing = false;
      this.creating = null;
      this.pendingMember = null;
      this.draft = "";
    }
    try {
      const snapshot = await this.rpc<Snapshot>("get", { spaceId: id });
      if (epoch !== this.epoch) {
        return;
      }
      this.snapshot = snapshot;
      const pageId = priorPage ?? new URL(location.href).searchParams.get("page");
      this.page = snapshot.pages.find((page) => page.id === pageId) ?? null;
      if (snapshot.space.role === "viewer") {
        this.editing = false;
        this.creating = null;
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
    this.editing = false;
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
      } else if (this.page) {
        page = await this.rpc<SpacePage>("page.save", {
          spaceId: this.page.spaceId,
          pageId: this.page.id,
          title: this.draftTitle,
          body: this.body,
          expectedRevision: this.page.revision,
        });
      } else {
        return;
      }
      this.creating = null;
      this.editing = false;
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
      this.notice = t("accepted");
      await this.loadHistory();
    });
  }
  private search() {
    void this.action(async () => {
      if (!this.snapshot || !this.query.trim()) {
        return;
      }
      const epoch = this.epoch;
      const result = await this.rpc<{ results: Hit[]; indexing?: boolean }>("search", {
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
  private tree(parentId: string | null = null, depth = 0): TemplateResult {
    return html`<ul>
      ${this.snapshot?.pages
        .filter((page) => page.parentId === parentId)
        .map(
          (page) =>
            html`<li>
              <button
                class="btn btn--sm"
                aria-current=${this.page?.id === page.id ? "page" : nothing}
                ?disabled=${this.busy || this.editing || Boolean(this.creating)}
                @click=${() => this.selectPage(page)}
              >
                ${page.title}</button
              >${depth < 20 ? this.tree(page.id, depth + 1) : nothing}
            </li>`,
        )}
    </ul>`;
  }
  override render() {
    const canEdit = this.snapshot && this.snapshot.space.role !== "viewer";
    return html`<main class="pc-spaces settings-page settings-page--wide">
      <header>
        <h1>${t("title")}</h1>
        <p>${t("intro")}</p>
        <button
          class="btn"
          ?disabled=${this.busy || this.loading}
          @click=${() => this.openCreate("space")}
        >
          ${t("createSpace")}</button
        ><button class="btn" ?disabled=${this.busy} @click=${() => this.refresh()}>
          ${t("refresh")}
        </button>
      </header>
      ${this.error ? html`<p class="callout danger" role="alert">${this.error}</p>` : nothing}${this
        .notice
        ? html`<p role="status">${this.notice}</p>`
        : nothing}${this.loading ? html`<p role="status">${t("loading")}</p>` : nothing}
      <div class="pc-spaces-layout">
        <nav aria-label=${t("title")}>
          ${this.spaces.map(
            (space) =>
              html`<button
                class="btn"
                ?disabled=${this.busy}
                @click=${() => this.selectSpace(space.id)}
              >
                ${space.name}
              </button>`,
          )}${this.snapshot ? this.tree() : nothing}
        </nav>
        <section>
          ${this.snapshot
            ? html`<h2>${this.snapshot.space.name}</h2>
                <p class="callout">${t("sharedNotice")} · ${t(this.snapshot.space.role)}</p>
                <button
                  class="btn"
                  @click=${() => {
                    this.membersOpen = !this.membersOpen;
                  }}
                >
                  ${t("members")}</button
                >${canEdit
                  ? html`<button
                        data-new-page
                        class="btn"
                        ?disabled=${this.busy}
                        @click=${() => this.openCreate("page")}
                      >
                        ${t("createPage")}</button
                      >${this.page
                        ? html`<button
                            class="btn"
                            ?disabled=${this.busy}
                            @click=${() => this.openCreate("page", this.page!.id)}
                          >
                            ${t("createChild")}
                          </button>`
                        : nothing}`
                  : nothing}
                <form
                  @submit=${(event: Event) => {
                    event.preventDefault();
                    this.search();
                  }}
                >
                  <label
                    >${t("search")}<input
                      .value=${this.query}
                      @input=${(event: Event) => {
                        this.query = (event.target as HTMLInputElement).value;
                      }} /></label
                  ><button class="btn" ?disabled=${this.busy}>${t("search")}</button>
                </form>
                ${this.hits.map(
                  (hit) =>
                    html`<article class="card">
                      <button
                        class="btn"
                        @click=${() => {
                          const page = this.snapshot?.pages.find((item) => item.id === hit.pageId);
                          if (page) {
                            this.selectPage(page, hit.messageId);
                          }
                        }}
                      >
                        ${hit.pageTitle}
                      </button>
                      <p>${hit.snippet}</p>
                    </article>`,
                )}
                ${this.membersOpen ? this.renderMembers() : nothing}`
            : html`<p>${t("chooseSpace")}</p>`}
          ${this.creating || this.editing
            ? html`<form
                class="card"
                @submit=${(event: Event) => {
                  event.preventDefault();
                  this.save();
                }}
              >
                <h3>
                  ${t(
                    this.creating === "space"
                      ? "createSpace"
                      : this.creating
                        ? "createPage"
                        : "edit",
                  )}
                </h3>
                <label
                  >${t("name")}<input
                    data-title
                    required
                    maxlength="160"
                    .value=${this.draftTitle}
                    @input=${(event: Event) => {
                      this.draftTitle = (event.target as HTMLInputElement).value;
                      this.createRequestId = crypto.randomUUID();
                    }} /></label
                >${this.creating !== "space"
                  ? html`<label
                      >${t("body")}<textarea
                        rows="8"
                        maxlength="32000"
                        .value=${this.body}
                        @input=${(event: Event) => {
                          this.body = (event.target as HTMLTextAreaElement).value;
                          this.createRequestId = crypto.randomUUID();
                        }}
                      ></textarea>
                    </label>`
                  : nothing}<button class="btn primary" ?disabled=${this.busy}>${t("save")}</button
                ><button
                  type="button"
                  class="btn"
                  ?disabled=${this.busy}
                  @click=${() => this.cancelEdit()}
                >
                  ${t("cancel")}
                </button>
              </form>`
            : nothing}
          ${this.page && !this.editing && !this.creating
            ? html`<article class="card">
                  <h2>${this.page.title}</h2>
                  <p class="muted">
                    ${t("revision")} ${this.page.revision} ·
                    ${new Date(this.page.updatedAt).toLocaleString()}
                  </p>
                  <div class="pc-space-text">${this.page.body}</div>
                  ${canEdit
                    ? html`<button
                        class="btn"
                        @click=${() => {
                          this.editing = true;
                          this.draftTitle = this.page!.title;
                          this.body = this.page!.body;
                        }}
                      >
                        ${t("edit")}
                      </button>`
                    : nothing}
                </article>
                <section class="card" aria-label=${t("conversation")}>
                  <h3>${t("conversation")}</h3>
                  ${this.historyAnchor
                    ? html`<button
                        class="btn"
                        @click=${() => {
                          this.historyAnchor = "";
                          void this.loadHistory();
                        }}
                      >
                        ${t("latest")}
                      </button>`
                    : nothing}
                  ${this.streaming
                    ? html`<article class="pc-space-message">
                        <strong>AI</strong>
                        <div class="pc-space-text">${this.streaming}</div>
                      </article>`
                    : nothing}
                  ${this.messages.map(
                    (message) =>
                      html`<article class="pc-space-message" id=${`message-${message.id}`}>
                        <strong
                          >${message.role === "assistant"
                            ? "AI"
                            : (message.authorName ?? t("unknownAuthor"))}</strong
                        >
                        ${message.timestamp
                          ? html`<time>${new Date(message.timestamp).toLocaleString()}</time>`
                          : nothing}
                        <div class="pc-space-text">${message.text}</div>
                      </article>`,
                  )}${canEdit
                    ? html`<form
                        @submit=${(event: Event) => {
                          event.preventDefault();
                          this.send();
                        }}
                      >
                        <label
                          >${t("ask")}<textarea
                            rows="3"
                            maxlength="16000"
                            .value=${this.draft}
                            @input=${(event: Event) => {
                              this.draft = (event.target as HTMLTextAreaElement).value;
                              this.draftRequestId = crypto.randomUUID();
                            }}
                          ></textarea></label
                        ><button class="btn primary" ?disabled=${this.busy || !this.draft.trim()}>
                          ${t("send")}
                        </button>
                      </form>`
                    : html`<p>${t("viewerNotice")}</p>`}
                </section>`
            : nothing}
        </section>
      </div>
    </main>`;
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
