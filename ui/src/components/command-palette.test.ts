/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../app/context.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { CommandPalette } from "./command-palette.ts";

type GatewayHarness = {
  gateway: ApplicationGateway;
  setConnected: (connected: boolean) => void;
};

function createGateway(connected: boolean): GatewayHarness {
  const client = {
    request: vi.fn(async () => ({ results: [], totalCount: 0, hasMore: false })),
  } as unknown as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceRoute: { mode: "direct" },
    hello: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://localhost", token: "", bootstrapToken: "", password: "" },
    eventLog: [],
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } satisfies ApplicationGateway;
  return {
    gateway,
    setConnected(nextConnected) {
      snapshot = {
        ...snapshot,
        phase: nextConnected ? "connected" : "reconnecting",
      };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createContext(
  gateway: ApplicationGateway,
  list: ApplicationContext<RouteId>["sessions"]["list"],
): ApplicationContext<RouteId> {
  return {
    gateway,
    agentSelection: { state: { scopeId: "main" }, subscribe: () => () => {} },
    sessions: {
      state: { result: null },
      list,
    },
  } as unknown as ApplicationContext<RouteId>;
}

function createSessionResult(key: string, displayName: string): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: 1,
    defaults: {},
    sessions: [{ key, kind: "direct", displayName, updatedAt: 1 }],
  } as SessionsListResult;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function mountPalette(context: ApplicationContext<RouteId>) {
  const provider = createApplicationContextProvider(context);
  const palette = document.createElement("openclaw-command-palette") as CommandPalette;
  palette.onNavigate = vi.fn();
  palette.onSelectSession = vi.fn();
  provider.append(palette);
  document.body.append(provider);
  await palette.updateComplete;
  return { palette, provider };
}

async function enterQuery(palette: CommandPalette, query: string) {
  palette.openPalette();
  await palette.updateComplete;
  const input = palette.querySelector<HTMLInputElement>(".cmd-palette__input");
  if (!input) {
    throw new Error("Expected command palette input");
  }
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await palette.updateComplete;
}

describe("CommandPalette lifecycle", () => {
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("closes and clears its query before a retained element reconnects", async () => {
    const { gateway } = createGateway(true);
    const list = vi.fn(async () => createSessionResult("agent:main:old", "Old chat"));
    const { palette, provider } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "old");
    await vi.advanceTimersByTimeAsync(250);
    await palette.updateComplete;
    expect(palette.textContent).toContain("Old chat");

    palette.remove();
    provider.append(palette);
    const modal = palette.querySelector("openclaw-modal-dialog");
    const dialog = modal?.shadowRoot
      ?.querySelector("wa-dialog")
      ?.shadowRoot?.querySelector("dialog");
    expect(dialog?.open).toBe(false);
    await palette.updateComplete;

    expect(palette.querySelector("dialog")).toBeNull();
    palette.openPalette();
    await palette.updateComplete;
    expect(palette.querySelector<HTMLInputElement>(".cmd-palette__input")?.value).toBe("");
    expect(palette.textContent).not.toContain("Old chat");
  });

  it("retries the pending query after the gateway reconnects", async () => {
    const harness = createGateway(true);
    const stale = createDeferred<SessionsListResult | null>();
    const list = vi
      .fn<ApplicationContext<RouteId>["sessions"]["list"]>()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(createSessionResult("agent:main:retry", "Retry chat"));
    const { palette } = await mountPalette(createContext(harness.gateway, list));
    await enterQuery(palette, "retry");
    await vi.advanceTimersByTimeAsync(250);
    expect(list).toHaveBeenCalledOnce();

    harness.setConnected(false);
    stale.resolve(createSessionResult("agent:main:stale", "Stale chat"));
    await Promise.resolve();
    expect(palette.textContent).not.toContain("Stale chat");

    harness.setConnected(true);
    await palette.updateComplete;
    await vi.advanceTimersByTimeAsync(250);
    await palette.updateComplete;

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "retry" }));
    expect(palette.textContent).toContain("Retry chat");
  });

  it("drops an old provider response and searches the replacement context", async () => {
    const initial = createGateway(true);
    const replacement = createGateway(true);
    const stale = createDeferred<SessionsListResult | null>();
    const initialList = vi.fn(() => stale.promise);
    const replacementList = vi.fn(async () =>
      createSessionResult("agent:main:fresh", "Fresh chat"),
    );
    const { palette, provider } = await mountPalette(createContext(initial.gateway, initialList));
    await enterQuery(palette, "chat");
    await vi.advanceTimersByTimeAsync(250);
    expect(initialList).toHaveBeenCalledOnce();

    stale.resolve(createSessionResult("agent:main:stale", "Stale chat"));
    provider.setContext(createContext(replacement.gateway, replacementList));
    await palette.updateComplete;
    await vi.advanceTimersByTimeAsync(250);
    await palette.updateComplete;

    expect(replacementList).toHaveBeenCalledOnce();
    expect(palette.textContent).toContain("Fresh chat");
    expect(palette.textContent).not.toContain("Stale chat");
  });

  it("navigates to the plugin manager from search", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => createSessionResult("agent:main:test", "Test")),
      ),
    );
    await enterQuery(palette, "plugins");

    const item = palette.querySelector<HTMLButtonElement>("#cmd-palette-option-nav-plugins");
    expect(item?.textContent).toContain("Plugins");
    item?.click();

    expect(palette.onNavigate).toHaveBeenCalledWith("plugins");
  });
  it("keeps hosted search focused on conversations and hands off the exact message", async () => {
    const { gateway } = createGateway(true);
    const hit = {
      sessionKey: "agent:main:old",
      sessionId: "generation-2",
      messageId: "message-120",
      role: "assistant",
      timestamp: 1,
      snippet: "배포실패 해결",
      score: 1,
      title: "Archived launch",
    };
    const request = vi.fn(async () => ({ results: [hit], totalCount: 1, hasMore: false }));
    gateway.snapshot.client!.request = request as GatewayBrowserClient["request"];
    const list = vi.fn(async () => createSessionResult("agent:main:title-only", "배포 계획"));
    const { palette } = await mountPalette(createContext(gateway, list));
    palette.searchOnly = true;
    palette.onSelectSearchHit = vi.fn();
    await enterQuery(palette, "배포");
    expect(palette.querySelectorAll(".cmd-palette__item")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    await palette.updateComplete;

    expect(request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ scope: "agent", mode: "substring", query: "배포" }),
    );
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ archivedFilter: "all" }));
    expect(palette.textContent).toContain("Archived launch");
    expect(palette.textContent).toContain("Assistant");
    expect(palette.querySelector("mark")?.textContent).toBe("배포");
    expect(palette.querySelector("#cmd-palette-option-nav-config")).toBeNull();
    expect(palette.querySelector("#cmd-palette-option-slash-verbose")).toBeNull();
    const input = palette.querySelector<HTMLInputElement>(".cmd-palette__input")!;
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    await palette.updateComplete;
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
    expect(palette.onSelectSearchHit).not.toHaveBeenCalled();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(palette.onSelectSearchHit).toHaveBeenCalledWith({
      sessionKey: hit.sessionKey,
      sessionId: hit.sessionId,
      messageId: hit.messageId,
      query: "배포",
    });
    expect(palette.isOpen).toBe(false);
  });

  it("discards a previous body query during the debounce window", async () => {
    const { gateway } = createGateway(true);
    const stale = createDeferred<{ results: unknown[] }>();
    gateway.snapshot.client!.request = vi.fn(
      () => stale.promise,
    ) as GatewayBrowserClient["request"];
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => createSessionResult("agent:main:old", "Old title")),
      ),
    );
    palette.searchOnly = true;
    await enterQuery(palette, "old");
    await vi.advanceTimersByTimeAsync(250);
    const input = palette.querySelector<HTMLInputElement>(".cmd-palette__input")!;
    input.value = "new";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    stale.resolve({
      results: [
        {
          sessionKey: "agent:main:old",
          sessionId: "old",
          messageId: "old",
          role: "user",
          timestamp: 1,
          snippet: "stale needle",
          score: 1,
        },
      ],
    });
    await Promise.resolve();
    await palette.updateComplete;
    expect(palette.textContent).not.toContain("Old title");
    expect(palette.textContent).not.toContain("stale needle");
  });

  it("shows recoverable failures and appends paged results", async () => {
    const { gateway } = createGateway(true);
    const hit = (id: string) => ({
      sessionKey: `agent:main:${id}`,
      sessionId: id,
      messageId: id,
      role: "user",
      timestamp: 1,
      snippet: `needle ${id}`,
      score: 1,
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce({
        results: Array.from({ length: 11 }, (_, index) =>
          hit(index === 0 ? "first" : index === 10 ? "second" : `middle-${index}`),
        ),
        totalCount: 11,
        hasMore: false,
      });
    gateway.snapshot.client!.request = request;
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => ({ sessions: [] }) as unknown as SessionsListResult),
      ),
    );
    palette.searchOnly = true;
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(250);
    await palette.updateComplete;
    const retry = palette.querySelector<HTMLButtonElement>(".cmd-palette__status button");
    expect(retry).not.toBeNull();
    retry!.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await palette.updateComplete;
    await vi.waitFor(() => expect(palette.textContent).toContain("needle first"));
    palette.querySelector<HTMLButtonElement>(".cmd-palette__more")!.click();
    await vi.waitFor(() => expect(palette.querySelectorAll(".cmd-palette__item")).toHaveLength(11));
    await palette.updateComplete;
    expect(request).toHaveBeenLastCalledWith(
      "sessions.search",
      expect.objectContaining({ offset: 0 }),
    );
    await vi.waitFor(() => expect(palette.querySelectorAll(".cmd-palette__item")).toHaveLength(11));
    expect(palette.querySelector(".cmd-palette__more")).toBeNull();
  });
  it("discards pending all-agent results when selection changes", async () => {
    const { gateway } = createGateway(true);
    const stale = createDeferred<{ results: unknown[]; totalCount: number; hasMore: boolean }>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue({ results: [], totalCount: 0, hasMore: false });
    gateway.snapshot.client!.request = request;
    let notify: (() => void) | undefined;
    const context = {
      ...createContext(
        gateway,
        vi.fn(async () => ({ sessions: [] }) as unknown as SessionsListResult),
      ),
      agentSelection: {
        state: { scopeId: null as string | null },
        subscribe: (listener: () => void) => {
          notify = listener;
          return () => {};
        },
      },
      agents: { state: { agentsList: { agents: [{ id: "main" }, { id: "writer" }] } } },
    } as unknown as ApplicationContext<RouteId>;
    const { palette } = await mountPalette(context);
    palette.searchOnly = true;
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(2);
    context.agentSelection.state.scopeId = "main";
    notify!();
    stale.resolve({
      results: [
        {
          sessionKey: "agent:writer:stale",
          sessionId: "stale",
          messageId: "stale",
          role: "user",
          timestamp: 1,
          snippet: "stale all-agent result",
          score: 0,
        },
      ],
      totalCount: 1,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(250);
    await palette.updateComplete;
    expect(request).toHaveBeenCalledTimes(3);
    expect(palette.textContent).not.toContain("stale all-agent result");
    expect(request).toHaveBeenLastCalledWith(
      "sessions.search",
      expect.objectContaining({ agentId: "main" }),
    );
  });
  it("includes archived title-only matches and opens their conversation", async () => {
    const { gateway } = createGateway(true);
    const archived = {
      ...createSessionResult("agent:main:archived", "Archived deployment"),
      sessions: [
        {
          key: "agent:main:archived",
          kind: "direct",
          displayName: "Archived deployment",
          archived: true,
          updatedAt: 1,
        },
      ],
    };
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => archived as SessionsListResult),
      ),
    );
    palette.searchOnly = true;
    await enterQuery(palette, "deployment");
    await vi.advanceTimersByTimeAsync(250);
    await palette.updateComplete;
    const item = palette.querySelector<HTMLElement>(".cmd-palette__item");
    expect(item?.textContent).toContain("Archived deployment");
    expect(palette.querySelector(".cmd-palette__snippet")).toBeNull();
    item?.click();
    expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:archived");
  });

  it("offers the next title page without declaring no matches before it is read", async () => {
    const { gateway } = createGateway(true);
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ key: "agent:main:cron:hidden", kind: "cron", updatedAt: 1 }],
        hasMore: true,
        nextOffset: 1,
      })
      .mockResolvedValueOnce(createSessionResult("agent:main:older", "Older deployment"));
    const { palette } = await mountPalette(createContext(gateway, list));
    palette.searchOnly = true;
    await enterQuery(palette, "deployment");
    await vi.advanceTimersByTimeAsync(250);
    await palette.updateComplete;
    expect(palette.querySelectorAll(".cmd-palette__item")).toHaveLength(0);
    expect(palette.querySelector(".cmd-palette__empty")).toBeNull();
    palette.querySelector<HTMLButtonElement>(".cmd-palette__more")!.click();
    await vi.waitFor(() => expect(palette.textContent).toContain("Older deployment"));
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 }));
    expect(palette.querySelector(".cmd-palette__more")).toBeNull();
  });

  it.each([
    { text: "İX 배포", query: "배포", match: "배포" },
    { text: "İa i", query: "i", match: "i" },
    { text: "ſ", query: "s", match: "ſ" },
    { text: "aXb a.b", query: "a.b", match: "a.b" },
  ])(
    "highlights literal Unicode match in original title/snippet offsets: $text",
    async ({ text, query, match }) => {
      const { gateway } = createGateway(true);
      gateway.snapshot.client!.request = vi.fn(async () => ({
        results: [
          {
            sessionKey: "agent:main:unicode",
            sessionId: "unicode",
            messageId: "unicode-message",
            role: "assistant",
            timestamp: 1,
            snippet: text,
            title: text,
            score: 0,
          },
        ],
        totalCount: 1,
        hasMore: false,
      })) as GatewayBrowserClient["request"];
      const { palette } = await mountPalette(
        createContext(
          gateway,
          vi.fn(async () => ({ sessions: [] }) as unknown as SessionsListResult),
        ),
      );
      palette.searchOnly = true;
      await enterQuery(palette, query);
      await vi.advanceTimersByTimeAsync(250);
      await palette.updateComplete;
      expect(
        Array.from(palette.querySelectorAll("mark"), (element) => element.textContent),
      ).toEqual([match, match]);
    },
  );
});
