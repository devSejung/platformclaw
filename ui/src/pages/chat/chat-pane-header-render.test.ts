/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";

describe("chat pane personal-agent session controls", () => {
  it("hides session sharing even when the private Gateway advertises it", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    pane.context = {
      ...pane.context,
      accessMode: "personal-agent",
      gateway: {
        ...pane.context.gateway,
        snapshot: {
          ...pane.context.gateway.snapshot,
          hello: {
            features: { methods: ["session.visibility.set"] },
            auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
          } as ApplicationContext["gateway"]["snapshot"]["hello"],
        },
      },
    } as ApplicationContext;
    const row = {
      key: "agent:main:current",
      visibility: "shared",
      sharingRole: "owner",
    } as GatewaySessionRow;
    state.sessionsResult = { sessions: [row] } as ChatPageHost["sessionsResult"];
    const container = document.createElement("div");

    render(
      pane.renderPaneHeader(
        createSessionWorkspaceProps(state),
        createBackgroundTasksProps(state, { onOpenSession: () => {} }),
        row,
        false,
        undefined,
        false,
      ),
      container,
    );

    expect(container.querySelector(".chat-pane__sharing-trigger")).toBeNull();
  });
});
