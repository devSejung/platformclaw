/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-embedded.test/"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";

// Keep this test at the container/canonical-send seam; the Space browser suite
// covers the real composer, Gateway chat.send, tools and run lifecycle together.
vi.mock("./chat-send-submit.ts", () => ({ handleSendChat: vi.fn(async () => undefined) }));

type EmbeddedPane = TestChatPane & {
  embedded: boolean;
  onCreateSession?: () => Promise<string | null>;
  applyActiveSessionBindings: () => void;
};

function createEmbeddedPane() {
  const sessions = {
    create: vi.fn(async () => "agent:main:unbound"),
    createResult: vi.fn(async () => ({ key: "agent:main:unbound" })),
    reset: vi.fn(),
  };
  const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
  const fixture = createTestChatPane({
    client,
    sessions: sessions as unknown as SessionCapability,
  });
  const pane = fixture.pane as EmbeddedPane;
  pane.embedded = true;
  pane.active = true;
  pane.sessionKey = fixture.state.sessionKey;
  return { ...fixture, pane, sessions, client };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(handleSendChat).mockClear();
  localStorage.clear();
});

describe("embedded canonical chat pane", () => {
  it.each([false, true])(
    "sends a /new prompt to the bound session when the parent has already adopted it: %s",
    async (parentAdopted) => {
      const { pane, state, sessions, client } = createEmbeddedPane();
      const key = "agent:main:space-session:00000000-0000-4000-8000-000000000004";
      pane.onCreateSession = vi.fn(async () => {
        // A container may commit its new tab before its creation promise resolves.
        if (parentAdopted) {
          pane.sessionKey = key;
          state.sessionKey = key;
        }
        return key;
      });
      const navigate = vi.fn();
      pane.onPaneSessionChange = navigate;
      const switchSession = vi.spyOn(pane, "switchPaneSession").mockImplementation((next) => {
        state.sessionKey = next;
      });
      vi.mocked(handleSendChat).mockImplementationOnce(async (host) => {
        expect(host.sessionKey).toBe(key);
      });

      await expect(pane.createSession("Compare the saved trace")).resolves.toBe(true);

      expect(pane.onCreateSession).toHaveBeenCalledOnce();
      expect(sessions.create).not.toHaveBeenCalled();
      expect(sessions.createResult).not.toHaveBeenCalled();
      expect(sessions.reset).not.toHaveBeenCalled();
      expect(client.request).not.toHaveBeenCalled();
      if (parentAdopted) {
        expect(switchSession).not.toHaveBeenCalled();
      } else {
        expect(switchSession).toHaveBeenCalledExactlyOnceWith(key);
      }
      expect(pane.sessionKey).toBe(key);
      expect(navigate).toHaveBeenCalledWith(expect.any(String), key);
      expect(handleSendChat).toHaveBeenCalledExactlyOnceWith(state, "Compare the saved trace");
    },
  );

  it.each(["cancelled", "missing"])(
    "leaves the current session untouched when container creation is %s",
    async (mode) => {
      const { pane, state, sessions, client } = createEmbeddedPane();
      const originalKey = state.sessionKey;
      pane.onCreateSession = mode === "cancelled" ? vi.fn(async () => null) : undefined;
      const navigate = vi.fn();
      pane.onPaneSessionChange = navigate;
      const switchSession = vi.spyOn(pane, "switchPaneSession");

      await expect(pane.createSession("Keep this prompt here")).resolves.toBe(false);

      expect(pane.sessionKey).toBe(originalKey);
      expect(state.sessionKey).toBe(originalKey);
      expect(switchSession).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(handleSendChat).not.toHaveBeenCalled();
      expect(sessions.create).not.toHaveBeenCalled();
      expect(sessions.createResult).not.toHaveBeenCalled();
      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it("does not adopt a container result after the connection changes", async () => {
    const { pane, state } = createEmbeddedPane();
    let resolve!: (key: string) => void;
    pane.onCreateSession = vi.fn(
      () =>
        new Promise<string>((complete) => {
          resolve = complete;
        }),
    );
    const switchSession = vi.spyOn(pane, "switchPaneSession");
    const originalKey = state.sessionKey;
    const pending = pane.createSession("Do not send after reconnect");
    await vi.waitFor(() => expect(pane.onCreateSession).toHaveBeenCalledOnce());
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    resolve("agent:main:space-session:00000000-0000-4000-8000-000000000005");

    await expect(pending).resolves.toBe(false);

    expect(state.sessionKey).toBe(originalKey);
    expect(switchSession).not.toHaveBeenCalled();
    expect(handleSendChat).not.toHaveBeenCalled();
  });

  it.each([true, false])("%s embedded binding respects global session ownership", (embedded) => {
    const { pane, state } = createEmbeddedPane();
    const previousKey = "agent:main:private-home";
    const boundKey = "agent:personal:space-session:00000000-0000-4000-8000-000000000006";
    const settings = patchSettings({ sessionKey: previousKey, lastActiveSessionKey: previousKey });
    state.settings = settings;
    pane.embedded = embedded;
    pane.sessionKey = boundKey;
    state.sessionKey = boundKey;
    const selectAgent = vi.spyOn(pane.context.agentSelection, "set");

    pane.applyActiveSessionBindings();

    if (embedded) {
      expect(state.settings).toBe(settings);
      expect(loadSettings().sessionKey).toBe(previousKey);
      expect(loadSettings().lastActiveSessionKey).toBe(previousKey);
      expect(pane.context.gateway.setSessionKey).not.toHaveBeenCalled();
      expect(selectAgent).not.toHaveBeenCalled();
      expect(pane.context.agentSelection.state.selectedId).toBe("main");
    } else {
      expect(state.settings.sessionKey).toBe(boundKey);
      expect(loadSettings().sessionKey).toBe(boundKey);
      expect(loadSettings().lastActiveSessionKey).toBe(boundKey);
      expect(pane.context.gateway.setSessionKey).toHaveBeenCalledExactlyOnceWith(boundKey);
      expect(selectAgent).toHaveBeenCalledExactlyOnceWith("personal");
      expect(pane.context.agentSelection.state.selectedId).toBe("personal");
    }
  });
});
