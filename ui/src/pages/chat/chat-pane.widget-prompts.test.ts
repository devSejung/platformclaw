/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

type WidgetPane = TestChatPane & {
  prepareChatSubmit: (
    state: ChatPageHost,
    catalog: null,
    suggestion: boolean,
    canSend: boolean,
  ) => () => void;
  widgetPromptSend: (text: string, sourceSessionKey: string) => Promise<boolean>;
  resolveBoardView: () => { face: "chat" };
};

function setup(sessionKey = "agent:main:source") {
  const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
  const fixture = createTestChatPane({ client, sessions: {} as SessionCapability });
  const pane = fixture.pane as WidgetPane;
  const { state } = fixture;
  state.sessionKey = sessionKey;
  vi.spyOn(pane, "resolveBoardView").mockReturnValue({ face: "chat" });
  state.handleSendChat = vi.fn(async (_text, options) => {
    (options as { onAdmitted: () => void }).onAdmitted();
  });
  pane.prepareChatSubmit(state, null, false, true);
  return { pane, state };
}

describe("widget message pane ownership", () => {
  afterEach(() => vi.restoreAllMocks());
  it("accepts the canonical spelling of the visible main session", async () => {
    const { pane, state } = setup("main");
    expect(await pane.widgetPromptSend("Selection", "agent:main:main")).toBe(true);
    expect(state.handleSendChat).toHaveBeenCalledOnce();
    expect(state.sessionKey).toBe("main");
  });

  it.each(["source", "route", "client", "permission"])(
    "rejects a stale %s before submitting",
    async (change) => {
      const { pane, state } = setup();
      let source = state.sessionKey;
      if (change === "source") {
        source = "agent:main:other";
      }
      if (change === "route") {
        state.sessionKey = "agent:main:other";
      }
      if (change === "client") {
        state.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
      }
      if (change === "permission") {
        pane.prepareChatSubmit(state, null, false, false);
      }
      expect(await pane.widgetPromptSend("Selection", source)).toBe(false);
      expect(state.handleSendChat).not.toHaveBeenCalled();
    },
  );
});
