import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { platformClawT } from "./i18n.ts";
import { spaceGatewayErrorMessage } from "./space-gateway-request.ts";

type SpaceQaPost = {
  id: string;
  spaceId: string;
  pageId: string;
  revision: number;
  body: string;
  authorId: string;
  authorName: string;
  agentId: string;
  createdAt: number;
  bodyOffset: number;
  nextBodyOffset: number | null;
  truncated: boolean;
};
type PostList = { revision: number; posts: SpaceQaPost[]; nextCursor: string | null };
type PostRead = { revision: number; post: SpaceQaPost };
type PageScope = { spaceId: string; id: string };
type Request = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

/** Bounded reads belong to one page/access lifetime, including explicit continuations. */
export class SpaceQaPostsState {
  posts: SpaceQaPost[] = [];
  nextCursor: string | null = null;
  loading = false;
  error = "";
  private epoch = 0;
  constructor(private readonly changed: () => void) {}
  clear() {
    const hadContent =
      this.posts.length > 0 || this.nextCursor !== null || this.loading || this.error;
    this.epoch++;
    this.posts = [];
    this.nextCursor = null;
    this.loading = false;
    this.error = "";
    if (hadContent) {
      this.changed();
    }
  }
  async load(
    page: PageScope,
    request: Request,
    isCurrent: () => boolean,
    postId = "",
    older = false,
  ) {
    if (older && (this.loading || !this.nextCursor)) {
      return;
    }
    const epoch = ++this.epoch;
    this.loading = true;
    this.error = "";
    this.changed();
    try {
      const result = await request<PostList>("qa.list", {
        spaceId: page.spaceId,
        pageId: page.id,
        ...(older ? { cursor: this.nextCursor } : {}),
      });
      if (epoch !== this.epoch || !isCurrent()) {
        return;
      }
      const anchored = postId
        ? await request<PostRead>("qa.get", { spaceId: page.spaceId, pageId: page.id, postId })
        : null;
      if (epoch !== this.epoch || !isCurrent()) {
        return;
      }
      const unique = new Map<string, SpaceQaPost>(
        older ? this.posts.map((post) => [post.id, post]) : [],
      );
      for (const post of result.posts) {
        if (!unique.has(post.id)) {
          unique.set(post.id, post);
        }
      }
      if (anchored) {
        unique.set(anchored.post.id, anchored.post);
      }
      this.posts = [...unique.values()];
      this.nextCursor = result.nextCursor;
    } catch (error) {
      if (epoch === this.epoch && isCurrent()) {
        this.error = spaceGatewayErrorMessage(error);
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
        this.changed();
      }
    }
  }
  async readMore(page: PageScope, post: SpaceQaPost, request: Request) {
    if (this.loading || post.nextBodyOffset === null) {
      return;
    }
    const epoch = this.epoch;
    this.loading = true;
    this.error = "";
    this.changed();
    try {
      const { post: next } = await request<PostRead>("qa.get", {
        spaceId: page.spaceId,
        pageId: page.id,
        postId: post.id,
        bodyOffset: post.nextBodyOffset,
      });
      if (epoch !== this.epoch) {
        return;
      }
      // Immutable IDs/revisions and contiguous UTF-16 offsets prevent joining different records.
      if (
        next.id !== post.id ||
        next.revision !== post.revision ||
        next.bodyOffset !== post.nextBodyOffset ||
        next.spaceId !== page.spaceId ||
        next.pageId !== page.id ||
        (next.nextBodyOffset !== null && next.nextBodyOffset <= next.bodyOffset)
      ) {
        throw new Error(platformClawT("platformClaw.spaces.qaReadChanged"));
      }
      this.posts = this.posts.map((item) =>
        item.id === post.id
          ? { ...next, body: post.body + next.body, bodyOffset: post.bodyOffset }
          : item,
      );
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = spaceGatewayErrorMessage(error);
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
        this.changed();
      }
    }
  }
}

export function renderSpaceQaPosts(props: {
  state: SpaceQaPostsState;
  anchor: string;
  page: PageScope | null;
  request: Request;
}) {
  const t = (key: string) => platformClawT(`platformClaw.spaces.${key}`);
  const { state } = props;
  return html`<section class="pc-space-qa-posts" aria-label=${t("qaPosts")}>
    <h2>${t("qaPosts")}</h2>
    ${state.error ? html`<p class="pc-space-error" role="alert">${state.error}</p>` : nothing}
    ${state.loading ? html`<p role="status">${t("loading")}</p>` : nothing}
    ${state.posts.length
      ? state.posts
          .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .map(
            (post) => html`<article
              class="pc-space-message pc-space-qa-post"
              id=${`post-${post.id}`}
              data-source=${props.anchor === post.id ? "true" : nothing}
            >
              <div class="pc-space-message-meta">
                <strong>${post.authorName || t("unknownAuthor")}</strong>
                <span title=${post.agentId}>${t("agentOnBehalf")}</span>
                <time datetime=${new Date(post.createdAt).toISOString()}
                  >${new Date(post.createdAt).toLocaleString()}</time
                >
              </div>
              <div class="pc-space-message-body markdown-content">
                ${unsafeHTML(toSanitizedMarkdownHtml(post.body, { codeBlockChrome: "none" }))}
              </div>
              ${post.nextBodyOffset !== null
                ? html`<button
                    class="pc-space-text-button"
                    ?disabled=${state.loading}
                    @click=${() => {
                      if (props.page) {
                        void state.readMore(props.page, post, props.request);
                      }
                    }}
                  >
                    ${t("qaReadMore")}
                  </button>`
                : nothing}
            </article>`,
          )
      : html`<p class="pc-space-panel-hint">${t("emptyQaPosts")}</p>`}
    ${state.nextCursor
      ? html`<button
          class="btn"
          ?disabled=${state.loading}
          @click=${() => {
            if (props.page) {
              void state.load(props.page, props.request, () => true, "", true);
            }
          }}
        >
          ${t("qaLoadOlder")}
        </button>`
      : nothing}
  </section>`;
}
