// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { INTERNAL_SESSION_PATH_PARAM } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { SESSION_NAVIGATION_KEY_PARAM } from "../lib/sessions/route-navigation.ts";
import { loadPlatformClawChatRoute } from "./space-conversation-route.ts";

const uuid = "12345678-90ab-cdef-1234-567890abcdef";
const sessionKey = `agent:alice:space-session:${uuid}`;
const destination = { spaceId: "team-space", pageId: "issue-page", conversationId: uuid };
const basePath = "/platformclaw/app";

function harness(rows: GatewaySessionRow[] = []) {
  const result: SessionsListResult = {
    ts: 1,
    path: "",
    count: rows.length,
    sessions: rows,
    defaults: { modelProvider: null, model: null, contextTokens: null },
  };
  const request = vi.fn(async (): Promise<typeof destination | null> => destination);
  const list = vi.fn(async () => result);
  const context = {
    basePath,
    gateway: {
      snapshot: { phase: "connected", client: { request }, hello: null },
      subscribe: () => () => undefined,
    },
    agents: { state: { agentsList: { mainKey: "main" } } },
    agentSelection: { state: { selectedId: "alice" } },
    sessions: { state: { result }, list },
  } as unknown as ApplicationContext;
  const load = (path: string, search = "", signal = new AbortController().signal) =>
    loadPlatformClawChatRoute(
      context,
      { pathname: `${basePath}${path}`, search, hash: "" },
      "chat",
      signal,
    );
  return { context, request, list, load };
}

describe("Space conversation route ownership", () => {
  it.each([
    [`/chat/alice/space-session/${uuid}`, "", { sessionKey }],
    ["/chat", `?session=${encodeURIComponent(sessionKey)}`, { sessionKey }],
    ["/chat/alice/investigation-12345678", "", { agentId: "alice", shortId: "12345678" }],
    ["/chat/alice/1234567890ab", "", { agentId: "alice", shortId: "1234567890ab" }],
    [
      "/chat",
      `?${INTERNAL_SESSION_PATH_PARAM}=${encodeURIComponent(`${basePath}/chat/alice/12345678`)}`,
      { agentId: "alice", shortId: "12345678" },
    ],
    [
      "/chat/alice/12345678",
      `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(sessionKey)}`,
      { sessionKey },
    ],
  ])("redirects %s to its owning Space", async (path, search, params) => {
    const { load, request } = harness();
    await expect(load(path, search)).resolves.toEqual({
      type: "redirect",
      location: {
        pathname: `${basePath}/spaces`,
        search: `?space=team-space&page=issue-page&conversation=${uuid}`,
        hash: "",
      },
    });
    expect(request).toHaveBeenCalledWith("platformclaw.spaces.conversation.resolve", params);
  });

  it("does not render a missing reserved session as ordinary chat", async () => {
    const { load, request, list } = harness();
    request.mockResolvedValue(null);
    await expect(load(`/chat/alice/space-session/${uuid}`)).resolves.toHaveProperty(
      "type",
      "notFound",
    );
    expect(list).not.toHaveBeenCalled();
  });

  it("leaves ordinary literal chat routes on the native loader", async () => {
    const { load, request } = harness();
    await expect(load("/chat/alice/telegram/12345")).resolves.toMatchObject({
      kind: "session",
      sessionKey: "agent:alice:telegram:12345",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed when an ordinary session shares the short prefix", async () => {
    const { load } = harness([{ key: `agent:alice:thread:${uuid}`, kind: "direct", updatedAt: 1 }]);
    await expect(load("/chat/alice/12345678")).resolves.toHaveProperty("type", "notFound");
  });

  it.each(["navigation", "identity"])("rejects resolution after newer %s", async (change) => {
    const { context, load, request } = harness();
    let release!: (result: typeof destination) => void;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = load(`/chat/alice/space-session/${uuid}`, "", controller.signal);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    if (change === "navigation") {
      controller.abort();
    } else {
      context.gateway.snapshot.client = null;
    }
    release(destination);
    await expect(pending).rejects.toBeDefined();
  });
});
