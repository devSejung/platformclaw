/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatDocumentChangeHandler } from "./document-change-contract.ts";

type DocumentPane = TestChatPane & {
  prepareChatSubmit(
    state: ChatPageHost,
    catalog: CatalogSessionKey | null,
    suggestion: boolean,
    canSend: boolean,
  ): () => void;
  documentChangeSend?: ChatDocumentChangeHandler;
  forwardDocumentChangeRequest: ChatDocumentChangeHandler;
};

function setup() {
  const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
  const fixture = createTestChatPane({
    client,
    sessions: {} as SessionCapability,
    methods: ["chat.send"],
  });
  const pane = fixture.pane as DocumentPane;
  const { state } = fixture;
  const attachment = {
    url: "/api/chat/media/outgoing/agent%3Amain%3Acurrent/owned/full",
    kind: "document",
    label: "report.pdf",
    mimeType: "application/pdf",
  };
  const message = {
    id: "source-message",
    role: "assistant",
    content: [{ type: "attachment", attachment }],
  };
  state.chatMessages = [message];
  state.handleSendChat = vi.fn(async (_text, options) => {
    if (
      options &&
      typeof options === "object" &&
      "onAdmitted" in options &&
      typeof options.onAdmitted === "function"
    ) {
      options.onAdmitted();
      return;
    }
    throw new Error("Expected outbox admission callback");
  });
  pane.prepareChatSubmit(state, null, false, true);
  if (!pane.documentChangeSend) {
    throw new Error("Expected prepared document request owner");
  }
  const handler = pane.forwardDocumentChangeRequest;
  const source: Parameters<ChatDocumentChangeHandler>[0] = {
    sessionKey: state.sessionKey,
    messageId: message.id,
    message,
    sourceIdentity: attachment.url,
    label: attachment.label,
    pageUnit: "page",
  };
  const request = {
    pageNumber: 1,
    selectedText: "Revenue",
    instruction: "Clarify this paragraph.",
  };
  return { pane, state, source, request, handler, signal: new AbortController().signal };
}

afterEach(() => vi.restoreAllMocks());

describe("document request pane authority", () => {
  it("uses the owning pane rather than the globally focused pane", async () => {
    const owner = setup();
    const other = setup();
    owner.pane.active = false;
    other.pane.active = true;
    expect(await other.handler(owner.source, owner.request, owner.signal)).toMatchObject({
      admitted: false,
    });
    expect(await owner.handler(owner.source, owner.request, owner.signal)).toEqual({
      admitted: true,
    });
    expect(owner.state.handleSendChat).toHaveBeenCalledOnce();
    expect(other.state.handleSendChat).not.toHaveBeenCalled();
  });

  it.each(["permission", "session", "scope", "method", "archived", "catalog", "suggestion"])(
    "refuses a %s change through a previously prepared callback",
    async (change) => {
      const test = setup();
      if (change === "permission") {
        test.pane.prepareChatSubmit(test.state, null, false, false);
      }
      if (change === "session") {
        test.state.sessionKey = "agent:main:replacement";
        test.pane.prepareChatSubmit(test.state, null, false, true);
      }
      if (change === "scope" || change === "method") {
        const hello = test.pane.context.gateway.snapshot.hello;
        if (!hello) {
          throw new Error("Expected current Gateway hello");
        }
        test.pane.context.gateway.snapshot.hello = {
          ...hello,
          ...(change === "scope"
            ? { auth: { role: "operator", scopes: ["operator.read"] } }
            : { features: { methods: [] } }),
        };
      }
      if (change === "archived") {
        test.state.selectedChatSessionArchived = true;
      }
      if (change === "catalog") {
        test.pane.prepareChatSubmit(
          test.state,
          { catalogId: "external", hostId: "host", threadId: "thread" },
          false,
          true,
        );
      }
      if (change === "suggestion") {
        test.pane.prepareChatSubmit(test.state, null, true, true);
      }
      expect(await test.handler(test.source, test.request, test.signal)).toMatchObject({
        admitted: false,
      });
      expect(test.state.handleSendChat).not.toHaveBeenCalled();
    },
  );

  it("keeps a held row callback usable across ordinary composer rerenders", async () => {
    const test = setup();
    test.pane.prepareChatSubmit(test.state, null, false, true);
    expect(test.pane.forwardDocumentChangeRequest).toBe(test.handler);
    expect(await test.handler(test.source, test.request, test.signal)).toEqual({ admitted: true });
    expect(test.state.handleSendChat).toHaveBeenCalledOnce();
    test.pane.prepareChatSubmit(test.state, null, false, false);
    expect(await test.handler(test.source, test.request, test.signal)).toEqual({ admitted: false });
    expect(test.state.handleSendChat).toHaveBeenCalledOnce();
  });

  it("admits offline intent through the ordinary prepared composer policy", async () => {
    const test = setup();
    test.state.connected = false;
    test.pane.context.gateway.snapshot.phase = "offline";
    test.pane.context.gateway.snapshot.client = null;
    expect(await test.handler(test.source, test.request, test.signal)).toEqual({ admitted: true });
    expect(test.state.handleSendChat).toHaveBeenCalledOnce();
  });

  it("respects the canonical owned-session proxy authorization capability", async () => {
    const test = setup();
    const hello = test.pane.context.gateway.snapshot.hello;
    if (!hello) {
      throw new Error("Expected current Gateway hello");
    }
    test.pane.context.gateway.snapshot.hello = {
      ...hello,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["chat.send"], capabilities: ["control-ui.server-authorized-methods"] },
    };
    expect(await test.handler(test.source, test.request, test.signal)).toEqual({ admitted: true });
    expect(test.state.handleSendChat).toHaveBeenCalledOnce();
  });
});
