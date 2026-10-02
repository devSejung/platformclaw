import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { SpaceConversation } from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import type { ChatHistoryPagination } from "../pages/chat/chat-history-pagination.ts";
import {
  resolveChatHistoryPagination,
  type ChatHistoryResult,
} from "../pages/chat/chat-history.ts";
import { nativeHistoryMessageIdentity } from "../pages/chat/chat-pane-shared.ts";
import {
  ChatTranscriptController,
  renderChatThread,
  resetChatThreadSessionPresentationState,
} from "../pages/chat/components/chat-thread.ts";
import { platformClawT } from "./i18n.ts";

/** Bounded, explicitly requested pages of one authorized read-only transcript. */
export class SpaceConversationHistoryState {
  messages: unknown[] = [];
  pagination: ChatHistoryPagination = { hasMore: false };
  loading = false;
  private sessionId: string | undefined;
  private epoch = 0;
  constructor(private readonly changed: () => void) {}
  clear() {
    this.epoch++;
    this.messages = [];
    this.pagination = { hasMore: false };
    this.sessionId = undefined;
    this.loading = false;
  }
  async load(
    request: (params: Record<string, unknown>) => Promise<ChatHistoryResult>,
    older = false,
  ): Promise<void> {
    const pagination = this.pagination;
    if (older && (this.loading || !pagination.hasMore)) {
      return;
    }
    const offset = older && pagination.hasMore ? pagination.nextOffset : undefined;
    const epoch = ++this.epoch;
    this.loading = true;
    this.changed();
    try {
      const result = await request(offset !== undefined ? { offset } : {});
      if (epoch !== this.epoch) {
        return;
      }
      if (older && this.sessionId && result.sessionId !== this.sessionId) {
        // Offsets cannot cross transcript identities. Reload a current tail instead.
        this.clear();
        // Let the new generation report its own failure; this catch owns only the old page.
        return this.load(request);
      }
      const messages = result.messages ?? [];
      if (older) {
        const duplicates = new Map<string, number>();
        for (const message of this.messages) {
          const id = nativeHistoryMessageIdentity(message);
          if (id) {
            duplicates.set(id, (duplicates.get(id) ?? 0) + 1);
          }
        }
        this.messages = [
          ...messages.filter((message) => {
            const id = nativeHistoryMessageIdentity(message);
            const count = id ? (duplicates.get(id) ?? 0) : 0;
            if (!id || count === 0) {
              return true;
            }
            duplicates.set(id, count - 1);
            return false;
          }),
          ...this.messages,
        ];
      } else {
        this.messages = messages;
      }
      this.sessionId = result.sessionId;
      const next = resolveChatHistoryPagination(result);
      this.pagination =
        next.hasMore && offset !== undefined && next.nextOffset <= offset
          ? { hasMore: false }
          : next;
    } catch (error) {
      if (epoch === this.epoch) {
        throw error;
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
        this.changed();
      }
    }
  }
}

/** An own-session snapshot after losing write access; no personal client or mutation callbacks. */
class SpaceConversationHistory extends OpenClawLightDomElement {
  @property({ attribute: false }) conversationId = "";
  @property({ attribute: false }) messages: unknown[] = [];
  @property({ attribute: false }) ownerName = "";
  @property({ attribute: false }) loading = false;
  @property({ attribute: false }) hasMore = false;
  @property({ attribute: false }) onLoadOlder: () => void = () => undefined;
  private readonly transcript = new ChatTranscriptController(this);
  private readonly paneId = `space-history-${crypto.randomUUID()}`;
  override disconnectedCallback() {
    resetChatThreadSessionPresentationState(this.paneId);
    super.disconnectedCallback();
  }
  override render() {
    return html`<section class="card chat pc-space-readonly-history">
      ${this.hasMore
        ? html`<button
            class="btn pc-space-history-older"
            ?disabled=${this.loading}
            @click=${this.onLoadOlder}
          >
            ${platformClawT(`platformClaw.spaces.${this.loading ? "loading" : "loadOlder"}`)}
          </button>`
        : nothing}
      ${renderChatThread(
        {
          paneId: this.paneId,
          sessionKey: `space-conversation:${this.conversationId}`,
          messages: this.messages,
          loading: this.loading,
          toolMessages: [],
          streamSegments: [],
          stream: null,
          streamStartedAt: null,
          queue: [],
          showThinking: false,
          showToolCalls: true,
          sessions: null,
          assistantName: "AI",
          assistantAvatar: null,
          userName: this.ownerName,
          embedSandboxMode: "strict",
          allowExternalEmbedUrls: false,
          onDraftChange: () => undefined,
          onSend: () => undefined,
          onRequestUpdate: () => this.requestUpdate(),
        },
        this.transcript,
      )}
    </section>`;
  }
}
if (!customElements.get("platformclaw-space-conversation-history")) {
  customElements.define("platformclaw-space-conversation-history", SpaceConversationHistory);
}

export function renderSpaceConversation(props: {
  conversation: SpaceConversation | null;
  messages: unknown[];
  loading: boolean;
  hasMore: boolean;
  onLoadOlder: () => void;
  onCreate: () => Promise<string | null>;
  onSessionChange: (key: string) => void;
}) {
  const conversation = props.conversation;
  if (!conversation) {
    return nothing;
  }
  if (!conversation.canWrite) {
    return html`<platformclaw-space-conversation-history
      .conversationId=${conversation.id}
      .ownerName=${conversation.ownerName}
      .messages=${props.messages}
      .loading=${props.loading}
      .hasMore=${props.hasMore}
      .onLoadOlder=${props.onLoadOlder}
    ></platformclaw-space-conversation-history>`;
  }
  return html`<openclaw-chat-pane
    class="pc-space-personal-chat"
    .paneId=${"space-personal-chat"}
    .sessionKey=${conversation.sessionKey}
    .embedded=${true}
    .active=${true}
    .onCreateSession=${props.onCreate}
    .onPaneSessionChange=${(_paneId: string, key: string) => props.onSessionChange(key)}
  ></openclaw-chat-pane>`;
}
