// sessions_list tool tests cover session metadata projection, visibility
// helpers, and numeric argument validation.
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withSessionToolVisibilityRestrictions } from "../../plugin-sdk/session-visibility.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

const VALID_CONFIG: OpenClawConfig = {
  agents: { entries: { main: { default: true } } },
};

const mocks = vi.hoisted(() => ({
  gatewayCall: vi.fn(),
  createAgentToAgentPolicy: vi.fn(() => ({})),
  createSessionVisibilityGuard: vi.fn(async () => ({
    check: () => ({ allowed: true }),
  })),
  resolveEffectiveSessionToolsVisibility: vi.fn(() => "all"),
  resolveSandboxedSessionToolContext: vi.fn(() => ({
    mainKey: "main",
    alias: "main",
    requesterInternalKey: undefined,
    restrictToSpawned: false,
  })),
  getSessionStateVersions: vi.fn(
    (_refs: Array<{ sessionKey: string; agentId: string }>) =>
      ({}) as Record<string, Record<string, number>>,
  ),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.gatewayCall(opts),
}));

vi.mock("../../sessions/session-state-events.js", () => ({
  getSessionStateVersions: (refs: Array<{ sessionKey: string; agentId: string }>) =>
    mocks.getSessionStateVersions(refs),
  listAmbientGroupWatchTargets: () => new Set<string>(),
}));

vi.mock("./sessions-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./sessions-helpers.js")>();
  return {
    ...actual,
    createAgentToAgentPolicy: () => mocks.createAgentToAgentPolicy(),
    createSessionVisibilityGuard: async () => await mocks.createSessionVisibilityGuard(),
    resolveEffectiveSessionToolsVisibility: () => mocks.resolveEffectiveSessionToolsVisibility(),
    resolveSandboxedSessionToolContext: () => mocks.resolveSandboxedSessionToolContext(),
  };
});

type SessionsListDetails = {
  sessions?: Array<{
    channel?: string;
    archived?: boolean;
    pinned?: boolean;
    stateVersion?: number;
    [key: string]: unknown;
  }>;
};

function getSessionsListDetails(result: { details?: unknown }): SessionsListDetails {
  return result.details as SessionsListDetails;
}

describe("sessions-list-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgentToAgentPolicy.mockReturnValue({});
    mocks.createSessionVisibilityGuard.mockResolvedValue({
      check: () => ({ allowed: true }),
    });
    mocks.resolveEffectiveSessionToolsVisibility.mockReturnValue("all");
    mocks.resolveSandboxedSessionToolContext.mockReturnValue({
      mainKey: "main",
      alias: "main",
      requesterInternalKey: undefined,
      restrictToSpawned: false,
    });
    mocks.getSessionStateVersions.mockReturnValue({});
  });

  it("adds nonzero state versions with one batch lookup", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        { key: "agent:main:main", kind: "main", sessionId: "main-1" },
        { key: "agent:main:subagent:child", kind: "other", sessionId: "child-1" },
      ],
    });
    mocks.getSessionStateVersions.mockReturnValue({
      main: { "agent:main:main": 7, "agent:main:subagent:child": 0 },
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("call-state", {});

    expect(mocks.getSessionStateVersions).toHaveBeenCalledWith([
      { sessionKey: "agent:main:main", agentId: "main" },
      { sessionKey: "agent:main:subagent:child", agentId: "main" },
    ]);
    expect(getSessionsListDetails(result).sessions?.[0]?.stateVersion).toBe(7);
    expect(getSessionsListDetails(result).sessions?.[1]?.stateVersion).toBeUndefined();
  });

  it("never exposes incognito rows to cross-session tools", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "(multiple)",
      sessions: [
        { key: "agent:main:dashboard:visible", kind: "other" },
        { key: "agent:main:dashboard:incognito-private", kind: "other", incognito: true },
      ],
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("blind", {});

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual([
      "agent:main:dashboard:visible",
    ]);
  });

  it("applies hook-injected visibility restrictions before transcript hydration", async () => {
    const hidden = "agent:main:space-session:11111111-1111-1111-1111-111111111111";
    mocks.gatewayCall.mockImplementation(async (request: { method?: string; params?: unknown }) => {
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            { key: "agent:main:visible", kind: "other", sessionId: "visible" },
            { key: hidden, kind: "other", sessionId: "hidden" },
          ],
        };
      }
      if (request.method === "chat.history") {
        expect((request.params as { sessionKey?: string }).sessionKey).not.toBe(hidden);
        return { messages: [] };
      }
      return {};
    });
    const args = withSessionToolVisibilityRestrictions(
      { messageLimit: 1 },
      { denyKeySubstrings: [":space-session:"] },
    );

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "restricted",
      args,
    );

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual([
      "agent:main:visible",
    ]);
  });

  it("refills a limited listing after restricted Space rows consume the gateway page", async () => {
    const hidden = "agent:main:space-session:11111111-1111-1111-1111-111111111111";
    const ordinary = "agent:main:ordinary";
    const listRequests: Array<Record<string, unknown>> = [];
    mocks.gatewayCall.mockImplementation(async (request: { method?: string; params?: unknown }) => {
      if (request.method !== "sessions.list") {
        return {};
      }
      const requestParams = (request.params ?? {}) as Record<string, unknown>;
      listRequests.push(requestParams);
      if (requestParams.offset === 1) {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: ordinary, kind: "other", sessionId: "ordinary" }],
          limitApplied: 50,
          hasMore: false,
          nextOffset: null,
        };
      }
      return {
        path: "/tmp/sessions.json",
        sessions: [{ key: hidden, kind: "other", sessionId: "hidden" }],
        limitApplied: 1,
        hasMore: true,
        nextOffset: 1,
      };
    });
    const args = withSessionToolVisibilityRestrictions(
      { limit: 1 },
      { denyKeySubstrings: [":space-session:"] },
    );

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("refill", args);

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual([
      ordinary,
    ]);
    expect(listRequests).toEqual([
      expect.objectContaining({ limit: 1 }),
      expect.objectContaining({ limit: 50, offset: 1 }),
    ]);
  });

  it("deduplicates visible rows when activity ordering shifts between refill pages", async () => {
    const hidden = "agent:main:space-session:11111111-1111-1111-1111-111111111111";
    const first = "agent:main:ordinary-a";
    const second = "agent:main:ordinary-b";
    const third = "agent:main:ordinary-c";
    mocks.gatewayCall.mockImplementation(async (request: { method?: string; params?: unknown }) => {
      if (request.method !== "sessions.list") {
        return {};
      }
      const offset = (request.params as { offset?: unknown } | undefined)?.offset;
      if (offset === 2) {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            { key: first, kind: "other", sessionId: "a" },
            { key: third, kind: "other", sessionId: "c" },
          ],
          limitApplied: 50,
          hasMore: false,
          nextOffset: null,
        };
      }
      return {
        path: "/tmp/sessions.json",
        sessions: [
          { key: hidden, kind: "other", sessionId: "hidden" },
          { key: first, kind: "other", sessionId: "a" },
        ],
        limitApplied: 2,
        hasMore: true,
        nextOffset: 2,
      };
    });
    const args = withSessionToolVisibilityRestrictions(
      { limit: 2 },
      { denyKeySubstrings: [":space-session:"] },
    );

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "refill-reorder",
      args,
    );

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual([
      first,
      third,
    ]);
    expect(JSON.stringify(result.details)).not.toContain(second);
  });

  it.each([
    {
      kind: "Space",
      root: "agent:main:space-session:11111111-1111-1111-1111-111111111111",
      visible: false,
    },
    { kind: "ordinary", root: "agent:main:main", visible: true },
  ])("follows stored $kind ancestry before transcript hydration", async ({ root, visible }) => {
    const child = "agent:main:subagent:child";
    const grandchild = "agent:main:subagent:grandchild";
    mocks.gatewayCall.mockImplementation(async (request: { method?: string; params?: unknown }) => {
      if (request.method === "sessions.describe") {
        throw new Error("ancestry checks must not use transcript-capable sessions.describe");
      }
      if (request.method === "sessions.resolve") {
        const params = request.params as { key?: string; includeLineage?: boolean };
        expect(params.includeLineage).toBe(true);
        if (params.key === child) {
          return { ok: true, key: child, lineage: { parentSessionKey: root, spawnedBy: root } };
        }
        if (params.key === root) {
          return { ok: true, key: root, lineage: {} };
        }
        return { ok: false };
      }
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            { key: "agent:main:visible", kind: "other", sessionId: "visible" },
            {
              key: grandchild,
              kind: "other",
              sessionId: "grandchild",
              parentSessionKey: child,
              spawnedBy: child,
            },
          ],
        };
      }
      if (request.method === "chat.history") {
        if (!visible) {
          expect((request.params as { sessionKey?: string }).sessionKey).not.toBe(grandchild);
        }
        return { messages: [] };
      }
      return {};
    });
    const args = withSessionToolVisibilityRestrictions(
      { messageLimit: 1 },
      { denyKeySubstrings: [":space-session:"] },
    );

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "restricted-grandchild",
      args,
    );

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual([
      "agent:main:visible",
      ...(visible ? [grandchild] : []),
    ]);
    expect(mocks.gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.resolve",
        params: expect.objectContaining({ key: child, includeLineage: true }),
      }),
    );
  });

  it("removes an off-page Space child link from an ordinary listed parent", async () => {
    const root = "agent:main:space-session:11111111-1111-1111-1111-111111111111";
    const parent = "agent:main:main";
    mocks.gatewayCall.mockImplementation(async (request: { method?: string; params?: unknown }) => {
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: parent,
              kind: "main",
              sessionId: "ordinary-parent",
              childSessions: [root],
            },
          ],
        };
      }
      return {};
    });
    const args = withSessionToolVisibilityRestrictions(
      {},
      { denyKeySubstrings: [":space-session:"] },
    );

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "off-page-space-child",
      args,
    );

    expect(getSessionsListDetails(result).sessions).toEqual([
      expect.objectContaining({ key: "agent:main:main", childSessions: [] }),
    ]);
  });

  it("preserves authoritative Space ancestry when a child also appears under a live controller", async () => {
    const root = "agent:main:space-session:11111111-1111-1111-1111-111111111111";
    const child = "agent:main:subagent:controlled-child";
    const controller = "agent:main:dashboard:controller";
    mocks.gatewayCall.mockImplementation(async (request: { method?: string; params?: unknown }) => {
      if (request.method === "sessions.describe") {
        throw new Error("ancestry checks must not use transcript-capable sessions.describe");
      }
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: child,
              kind: "other",
              sessionId: "child",
              parentSessionKey: root,
              spawnedBy: controller,
            },
            {
              key: controller,
              kind: "other",
              sessionId: "controller",
              childSessions: [child],
            },
          ],
        };
      }
      if (request.method === "chat.history") {
        expect((request.params as { sessionKey?: string }).sessionKey).not.toBe(child);
        return { messages: [] };
      }
      return {};
    });
    const args = withSessionToolVisibilityRestrictions(
      { messageLimit: 1 },
      { denyKeySubstrings: [":space-session:"] },
    );

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "controller-navigation-split",
      args,
    );

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual([
      controller,
    ]);
    expect(getSessionsListDetails(result).sessions?.[0]?.childSessions).toEqual([]);
  });

  it("hydrates an off-page child reference before keeping its raw session link", async () => {
    const root = "agent:main:space-session:11111111-1111-1111-1111-111111111111";
    const child = "agent:main:subagent:off-page-child";
    const controller = "agent:main:dashboard:controller";
    const ancestryRequests: string[] = [];
    mocks.gatewayCall.mockImplementation(async (request: { method?: string; params?: unknown }) => {
      if (request.method === "sessions.describe") {
        throw new Error("ancestry checks must not use transcript-capable sessions.describe");
      }
      if (request.method === "sessions.resolve") {
        const key = (request.params as { key?: unknown } | undefined)?.key;
        if (key === child) {
          ancestryRequests.push(child);
          return {
            ok: true,
            key: child,
            lineage: { parentSessionKey: root, spawnedBy: controller },
          };
        }
        return { ok: false };
      }
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: controller,
              kind: "other",
              sessionId: "controller",
              childSessions: [child],
            },
          ],
        };
      }
      return {};
    });
    const args = withSessionToolVisibilityRestrictions(
      {},
      { denyKeySubstrings: [":space-session:"] },
    );

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "off-page-descendant",
      args,
    );

    expect(ancestryRequests).toEqual([child]);
    expect(getSessionsListDetails(result).sessions).toEqual([
      expect.objectContaining({ key: controller, childSessions: [] }),
    ]);
  });

  it("declares a complete focused row contract", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:subagent:child",
          agentId: "main",
          kind: "other",
          channel: "discord",
          label: "worker",
          displayName: "Worker",
          derivedTitle: "Investigate queue",
          lastMessagePreview: "done",
          spawnedBy: "agent:main:main",
          updatedAt: 100,
          archived: false,
          pinned: true,
          model: "openai/gpt-5.4-mini",
          contextTokens: 20_000,
          totalTokens: 1_200,
          status: "done",
          abortedLastRun: false,
          childSessions: ["agent:main:subagent:grandchild"],
        },
      ],
    });
    mocks.getSessionStateVersions.mockReturnValue({
      main: { "agent:main:subagent:child": 4 },
    });
    const tool = createSessionsListTool({ config: VALID_CONFIG });
    const result = await tool.execute("contract", {});

    expect(tool.outputSchema).toBeDefined();
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ count: number; sessions: Array<{ agentId: string; archived: boolean; channel: string; key: string; kind: "main" | "group" | "cron" | "hook" | "node" | "other"; pinned: boolean; abortedLastRun?: boolean; childSessions?: Array<string>; contextTokens?: number; derivedTitle?: string; displayName?: string; label?: string; lastMessagePreview?: string; messages?: Array<unknown>; model?: string; parentSessionKey?: string; stateVersion?: number; status?: "running" | "done" | "failed" | "killed" | "timeout"; totalTokens?: number; updatedAt?: number }>; visibility?: { mode: "self" | "tree" | "agent"; restricted: true; warning: string } }',
    );
    expect(result.details).toEqual({
      count: 1,
      sessions: [
        {
          key: "agent:main:subagent:child",
          agentId: "main",
          kind: "other",
          channel: "discord",
          archived: false,
          pinned: true,
          label: "worker",
          displayName: "Worker",
          derivedTitle: "Investigate queue",
          lastMessagePreview: "done",
          parentSessionKey: "agent:main:main",
          updatedAt: 100,
          stateVersion: 4,
          model: "openai/gpt-5.4-mini",
          contextTokens: 20_000,
          totalTokens: 1_200,
          status: "done",
          abortedLastRun: false,
          childSessions: ["agent:main:subagent:grandchild"],
        },
      ],
    });
  });

  it("keeps channel discovery but omits delivery routing metadata", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:dashboard:child",
              kind: "direct",
              sessionId: "sess-dashboard-child",
              deliveryContext: {
                channel: "discord",
                to: "discord:child",
                accountId: "acct-1",
                threadId: "thread-1",
              },
            },
            {
              key: "agent:main:telegram:topic",
              kind: "direct",
              sessionId: "sess-telegram-topic",
              deliveryContext: {
                channel: "telegram",
                to: "telegram:topic",
                accountId: "acct-2",
                threadId: 271,
              },
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const result = await tool.execute("call-1", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.map((session) => session.channel)).toEqual(["discord", "telegram"]);
    expect(details.sessions?.every((session) => !Object.hasOwn(session, "deliveryContext"))).toBe(
      true,
    );
  });

  it("prefers the explicit parent key over the legacy spawner", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:subagent:child",
          kind: "other",
          parentSessionKey: "agent:main:subagent:parent",
          spawnedBy: "agent:main:main",
        },
      ],
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("lineage", {});

    expect(getSessionsListDetails(result).sessions?.[0]?.parentSessionKey).toBe(
      "agent:main:subagent:parent",
    );
  });

  it("omits malformed agent keys and derives channels only from valid group keys", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:slack:channel:C123:thread:1710000000.000100",
              kind: "group",
              sessionId: "sess-slack-thread",
            },
            {
              key: "discord:group:ops",
              kind: "group",
              sessionId: "sess-discord-group",
            },
            {
              key: "agent:main:matrix:channel:!room:[2001:db8::1]",
              kind: "group",
              sessionId: "sess-matrix-room",
            },
            {
              key: "agent:main:agent:plugin:slack:channel:C123",
              kind: "group",
              sessionId: "sess-nested-agent",
            },
            {
              key: "agent::slack:channel:C123",
              kind: "group",
              sessionId: "sess-malformed-agent",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const result = await tool.execute("call-agent-scoped-channel", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.map((session) => session.channel)).toEqual([
      "slack",
      "discord",
      "matrix",
      "unknown",
    ]);
  });

  it("omits detailed runtime settings from discovery rows", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "sess-main",
              thinkingLevel: "high",
              fastMode: "auto",
              effectiveFastMode: "auto",
              effectiveFastModeSource: "config",
              fastAutoOnSeconds: 30,
              verboseLevel: "on",
              reasoningLevel: "deep",
              elevatedLevel: "on",
              responseUsage: "full",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const result = await tool.execute("call-3", {});
    const details = getSessionsListDetails(result);

    const session = details.sessions?.[0];
    expect(session).toEqual({
      key: "main",
      agentId: "main",
      kind: "main",
      channel: "unknown",
      archived: false,
      pinned: false,
    });
  });

  it("requests archived sessions and keeps management state", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:dashboard:archived",
          kind: "direct",
          archived: true,
          archivedAt: 20,
          pinned: false,
        },
      ],
    });
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const result = await tool.execute("call-archived", { archived: true });

    expect(mocks.gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.list",
        params: expect.objectContaining({ archived: true }),
      }),
    );
    expect(getSessionsListDetails(result).sessions?.[0]).toMatchObject({
      archived: true,
      pinned: false,
    });
    expect(getSessionsListDetails(result).sessions?.[0]).not.toHaveProperty("archivedAt");
  });

  it.each([
    [{ limit: 1.5 }, "limit must be a positive integer"],
    [{ activeMinutes: 0 }, "activeMinutes must be a positive integer"],
    [{ messageLimit: 1.5 }, "messageLimit must be a non-negative integer"],
    [{ messageLimit: -1 }, "messageLimit must be a non-negative integer"],
  ])("rejects invalid numeric parameter %o", async (params, message) => {
    // Reject before gateway dispatch so malformed limits cannot reach session
    // store queries.
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    await expect(tool.execute("call-4", params)).rejects.toThrow(message);
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });
});
