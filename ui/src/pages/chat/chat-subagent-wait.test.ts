import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveChatSubagentWait } from "./chat-subagent-wait.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import {
  renderChatSearchBar,
  renderChatThread,
  resetChatThreadPresentationState,
  toggleChatThreadSearch,
} from "./components/chat-thread.ts";
import { renderChatWorkingIndicator } from "./components/chat-working-indicator.ts";

const parent: GatewaySessionRow = {
  key: "agent:main:parent",
  kind: "direct",
  updatedAt: 1_000,
  hasActiveRun: false,
  hasActiveSubagentRun: true,
  startedAt: 1_000,
};
const child: GatewaySessionRow = {
  key: "agent:main:subagent:child",
  kind: "direct",
  updatedAt: 1_000,
  spawnedBy: parent.key,
  subagentRunState: "active",
  label: "Backend implementation",
  hasActiveRun: true,
};
const messages = [
  {
    role: "assistant",
    timestamp: 2_000,
    content: [
      {
        type: "toolCall",
        id: "yield",
        name: "sessions_yield",
        arguments: { message: "PRIVATE_YIELD_CONTEXT" },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "yield",
    toolName: "sessions_yield",
    timestamp: 2_001,
    content: [{ type: "text", text: '{"status":"yielded"}' }],
  },
];

describe("chat waiting on subagents", () => {
  afterEach(() => {
    resetChatThreadPresentationState();
  });

  it.each([
    { name: "an empty transcript", history: [] },
    {
      name: "a nonmatching transcript",
      history: [{ role: "user", content: "Delegate research", timestamp: 1_000 }],
    },
    { name: "a waiting yield", history: messages, markerText: "Handed off and waiting" },
    {
      name: "a resumed yield",
      history: [...messages, { role: "assistant", content: "Finished setup", timestamp: 3_000 }],
      markerText: "Resumed",
    },
  ])("shows no search matches with $name while a child is active", ({ history, markerText }) => {
    const transcript = createTestTranscript();
    const container = document.createElement("div");
    const paneId = "subagent-wait-search";
    const draw = () =>
      render(
        html`
          ${renderChatSearchBar(paneId, draw)}
          ${renderChatThread(
            {
              paneId,
              sessionKey: parent.key,
              selectedSession: parent,
              subagentSessions: [child],
              loading: false,
              messages: history,
              toolMessages: [],
              streamSegments: [],
              stream: null,
              streamStartedAt: null,
              queue: [],
              showThinking: false,
              showToolCalls: false,
              sessions: null,
              assistantName: "Molty",
              assistantAvatar: null,
              onDraftChange: () => {},
              onSend: () => {},
            },
            transcript,
          )}
        `,
        container,
      );
    try {
      draw();
      expect(container.querySelector(".chat-working-indicator--subagents")).not.toBeNull();
      toggleChatThreadSearch(paneId, draw);
      const search = container.querySelector<HTMLInputElement>(".agent-chat__search-bar input");
      expect(search).not.toBeNull();
      search!.value = "PRIVATE_YIELD_CONTEXT";
      search!.dispatchEvent(new Event("input", { bubbles: true }));
      expect(container.querySelector(".chat-working-indicator--subagents")).toBeNull();
      expect(container.querySelector(".chat-yield-marker")).toBeNull();
      expect(container.querySelector(".agent-chat__empty")?.textContent).toBe(
        "No matching messages",
      );

      search!.value = "";
      search!.dispatchEvent(new Event("input", { bubbles: true }));
      expect(container.querySelector(".agent-chat__empty")).toBeNull();
      expect(container.querySelector(".chat-working-indicator--subagents")).not.toBeNull();
      if (markerText) {
        expect(container.querySelector(".chat-yield-marker")?.textContent).toContain(markerText);
        search!.value = ` ${markerText.toUpperCase()} `;
        search!.dispatchEvent(new Event("input", { bubbles: true }));
        expect(container.querySelector(".agent-chat__empty")).toBeNull();
        expect(container.querySelector(".chat-yield-marker")?.textContent).toContain(markerText);
        expect(container.querySelector(".chat-working-indicator--subagents")).toBeNull();
      }
    } finally {
      transcript.hostDisconnected();
    }
  });

  it.each([
    {
      name: "idle parent with active descendants",
      session: parent,
      ownRunActive: false,
      waiting: true,
    },
    {
      name: "archived parent",
      session: { ...parent, archived: true },
      ownRunActive: false,
      waiting: false,
    },
    { name: "new local parent run", session: parent, ownRunActive: true, waiting: false },
    {
      name: "own run reported by the row",
      session: { ...parent, hasActiveRun: true },
      ownRunActive: false,
      waiting: false,
    },
    {
      name: "settled descendants despite a stale child row",
      session: { ...parent, hasActiveSubagentRun: false },
      ownRunActive: false,
      waiting: false,
    },
    {
      name: "yielded parent remains running without its own run",
      session: { ...parent, status: "running" as const, activeRunIds: [] },
      ownRunActive: false,
      waiting: true,
    },
  ])("$name", ({ session, ownRunActive, waiting }) => {
    const result = resolveChatSubagentWait({
      selectedSession: session,
      runActive: ownRunActive,
      messages,
      subagentSessions: [child],
    });
    expect(result !== null).toBe(waiting);
    if (waiting) {
      expect(result).toEqual({ startedAt: 2_000, child: { key: child.key, label: child.label } });
    }
  });

  it("does not need child rows and only links a sole active direct child", () => {
    const derive = (childRows?: GatewaySessionRow[]) =>
      resolveChatSubagentWait({
        selectedSession: parent,
        runActive: false,
        messages,
        subagentSessions: childRows,
      });
    expect(derive()).toEqual({ startedAt: 2_000 });
    expect(derive([child, { ...child, key: "agent:main:subagent:other" }])?.child).toBeUndefined();
    expect(derive([{ ...child, spawnedBy: "agent:main:other" }])?.child).toBeUndefined();
    expect(derive([{ ...child, hasActiveRun: false }])?.child).toBeUndefined();
    expect(derive([{ ...child, archived: true }])?.child).toBeUndefined();
    expect(
      derive([{ ...child, subagentRunState: "historical", hasActiveRun: true }])?.child,
    ).toBeUndefined();
    expect(
      derive([{ ...child, subagentRunState: undefined, hasActiveRun: true }])?.child,
    ).toBeUndefined();
    expect(
      derive([
        { ...child, controlOwnerSessionKey: "agent:main:other", parentSessionKey: parent.key },
      ])?.child,
    ).toBeUndefined();
    expect(
      derive([child, { ...child, key: "agent:main:grandchild", spawnedBy: child.key }])?.child?.key,
    ).toBe(child.key);
  });

  it("does not link a sole loaded active fork when the actual subagent is outside the capped list", () => {
    const fork = {
      key: "agent:main:fork",
      kind: "direct" as const,
      updatedAt: 1_000,
      parentSessionKey: parent.key,
      hasActiveRun: true,
      forkedFromParent: true,
    };
    expect(
      resolveChatSubagentWait({
        selectedSession: { ...parent, childSessions: [child.key, fork.key] },
        messages,
        subagentSessions: [fork],
      }),
    ).toEqual({ startedAt: 2_000 });
  });

  it.each([
    { name: "no delivered yield", history: [], startedAt: 1_000 },
    { name: "unknown own run start", history: messages, startedAt: undefined },
    { name: "yield predates latest own run", history: messages, startedAt: 3_000 },
  ])("omits elapsed time with $name", ({ history, startedAt }) => {
    expect(
      resolveChatSubagentWait({
        selectedSession: { ...parent, startedAt },
        runActive: false,
        messages: history,
      }),
    ).toEqual({ startedAt: null });
  });

  it("renders the wait without parent output usage or rotating phrases and navigates the child", () => {
    const container = document.createElement("div");
    const onOpenSession = vi.fn();
    const waitingSubagents = { startedAt: 2_000, child: { key: child.key, label: child.label! } };
    const draw = (startedAt: number | null) =>
      render(
        renderChatWorkingIndicator(
          { kind: "reading-indicator", key: "parent-wait", startedAt },
          { waitingSubagents, onOpenSession, outputTokens: 4_700 },
        ),
        container,
      );
    draw(2_000);
    expect(container.textContent).toContain("Waiting on subagents");
    expect(container.querySelector("openclaw-working-phrase")).toBeNull();
    expect(container.querySelector(".chat-working-indicator__tokens")).toBeNull();
    expect(container.querySelector("openclaw-elapsed-time")).toHaveProperty("startMs", 2_000);
    container.querySelector("button")?.click();
    expect(onOpenSession).toHaveBeenCalledWith(child.key);
    draw(2_000);
    expect(container.querySelector("openclaw-elapsed-time")).toHaveProperty("startMs", 2_000);
    draw(null);
    expect(container.querySelector("openclaw-elapsed-time")).toBeNull();
  });
});
