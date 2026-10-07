import { describe, expect, it, vi } from "vitest";
import {
  listSessionEntriesReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SessionsListResult } from "../session-utils.types.js";
import { sessionReadHandlers } from "./sessions-read.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

describe("sessions.list namespace exclusions", () => {
  it.each([
    { prefixes: [""] },
    { prefixes: [42] },
    { prefixes: Array.from({ length: 101 }, () => "agent:main:hidden:") },
  ])("rejects invalid prefix filters before loading runtime state: %j", async ({ prefixes }) => {
    const respond = vi.fn();
    await sessionReadHandlers["sessions.list"]!({
      params: { excludeSessionKeyPrefixes: prefixes },
      respond,
      context: {},
      client: null,
    } as never);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("excludes namespaces before count, paging, search, lineage and cached response selection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
      const entries = [
        { key: "agent:main:hidden:first", updatedAt: 500, visibility: "shared" as const },
        { key: "agent:main:first", updatedAt: 400, visibility: "shared" as const },
        { key: "agent:main:private", updatedAt: 300, visibility: "draft" as const },
        { key: "agent:main:hidden:second", updatedAt: 200, visibility: "shared" as const },
        { key: "agent:main:second", updatedAt: 100, visibility: "shared" as const },
      ];
      const now = Date.now();
      for (const entry of entries) {
        const updatedAt = now - (500 - entry.updatedAt);
        await replaceSessionEntry(
          { agentId: "main", sessionKey: entry.key },
          {
            sessionId: entry.key.split(":").join("-"),
            updatedAt,
            lastInteractionAt: updatedAt,
            label: "matching",
            visibility: entry.visibility,
            createdActor: { type: "human", id: "owner" },
            ...(entry.key.includes(":hidden:") ? { parentSessionKey: "agent:main:first" } : {}),
          },
        );
      }
      expect(listSessionEntriesReadOnly({ agentId: "main" })).toHaveLength(entries.length);
      const client = {
        connect: { scopes: ["operator.read"] },
        authenticatedUserProfile: {
          profileId: "viewer",
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
      } as GatewayClient;
      const context = {
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => config,
        loadGatewayModelCatalog: async () => [],
        logGateway: { debug: vi.fn() },
      } as unknown as GatewayRequestContext;
      async function list(excludeSessionKeyPrefixes?: string[], offset = 0) {
        const responses: Parameters<RespondFn>[] = [];
        await sessionReadHandlers["sessions.list"]!({
          params: {
            agentId: "main",
            limit: 1,
            offset,
            search: "matching",
            sortBy: "lastInteractionAt",
            ...(excludeSessionKeyPrefixes ? { excludeSessionKeyPrefixes } : {}),
          },
          client,
          context,
          respond: (...response: Parameters<RespondFn>) => responses.push(response),
        } as never);
        expect(responses).toHaveLength(1);
        expect(responses[0]?.[0]).toBe(true);
        return responses[0]?.[1] as SessionsListResult;
      }
      const normal = await list();
      expect(normal.totalCount).toBe(4);
      expect(normal.sessions[0]?.key).toBe("agent:main:hidden:first");
      const first = await list(["AGENT:MAIN:HIDDEN:"]);
      expect(first).toMatchObject({ count: 1, totalCount: 2, nextOffset: 1, hasMore: true });
      expect(first.sessions[0]?.key).toBe("agent:main:first");
      expect(first.sessions[0]?.childSessions).toBeUndefined();
      const second = await list(["AGENT:MAIN:HIDDEN:"], 1);
      expect(second).toMatchObject({ count: 1, totalCount: 2, nextOffset: null, hasMore: false });
      expect(second.sessions[0]?.key).toBe("agent:main:second");
      expect(await list()).toEqual(normal);
    });
  });
});
