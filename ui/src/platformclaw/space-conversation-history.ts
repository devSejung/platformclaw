import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { SpaceConversation } from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import {
  ChatTranscriptController,
  renderChatThread,
  resetChatThreadSessionPresentationState,
} from "../pages/chat/components/chat-thread.ts";

/** An own-session snapshot after losing write access; no personal client or mutation callbacks. */
class SpaceConversationHistory extends OpenClawLightDomElement {
  @property({ attribute: false }) conversationId = "";
  @property({ attribute: false }) messages: unknown[] = [];
  @property({ attribute: false }) ownerName = "";
  @property({ attribute: false }) loading = false;
  private readonly transcript = new ChatTranscriptController(this);
  private readonly paneId = `space-history-${crypto.randomUUID()}`;
  override disconnectedCallback() {
    resetChatThreadSessionPresentationState(this.paneId);
    super.disconnectedCallback();
  }
  override render() {
    return html`<section class="card chat pc-space-readonly-history">
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
