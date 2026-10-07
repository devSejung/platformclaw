import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";

describe("browser subagent activity evidence", () => {
  it.each([
    { name: "visible and hidden live children", contributors: ["owned", "foreign"], active: true },
    { name: "hidden live child only", contributors: ["foreign"], active: false },
    { name: "completed children", contributors: [], active: false },
    { name: "unlinked contributor", contributors: ["unlinked"], active: false },
    {
      name: "self activity with hidden children",
      contributors: ["foreign"],
      self: true,
      active: true,
    },
  ])("projects $name without exposing evidence", async ({ contributors, self, active }) => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    const owned = `agent:${binding.agentId}:child`;
    const keys = {
      owned,
      foreign: "agent:other:child",
      unlinked: `agent:${binding.agentId}:unlinked`,
    };
    const row = {
      key,
      agentId: binding.agentId,
      childSessions: [owned, keys.foreign],
      activeChildSessions: contributors.map(
        (contributor) => keys[contributor as keyof typeof keys],
      ),
      hasActiveSubagentRun: true,
      ...(self ? { subagentRunState: "active" } : {}),
    };
    const expected = {
      key,
      agentId: binding.agentId,
      childSessions: [owned],
      hasActiveSubagentRun: active,
      ...(self ? { subagentRunState: "active" } : {}),
    };
    const original = structuredClone(row);
    // Child rows are deliberately absent: pagination must not erase visible activity.
    request.mockResolvedValueOnce({ sessions: [row], totalCount: 20 });
    await expect(proxy.request(token, "sessions.list", { limit: 1 })).resolves.toEqual({
      sessions: [expected],
      totalCount: 20,
    });
    request.mockResolvedValueOnce({ session: row });
    await expect(proxy.request(token, "sessions.describe", { key })).resolves.toEqual({
      session: expected,
    });
    await expect(
      proxy.filterEvent(token, {
        event: "sessions.changed",
        payload: { sessionKey: key, ...row, session: row },
      }),
    ).resolves.toEqual({
      event: "sessions.changed",
      payload: { sessionKey: key, ...expected, session: expected },
    });
    expect(row).toEqual(original);
  });

  it.each(["session.message", "agent", "session.tool"])(
    "strips activity evidence from admitted %s snapshots without widening event access",
    async (event) => {
      const { binding, proxy, token } = await setup();
      const sessionKey = `agent:${binding.agentId}:main`;
      const child = `agent:${binding.agentId}:child`;
      const row = {
        key: sessionKey,
        agentId: binding.agentId,
        childSessions: [child],
        activeChildSessions: [child, "agent:other:unlinked"],
        hasActiveSubagentRun: true,
      };
      const expected = {
        key: sessionKey,
        agentId: binding.agentId,
        childSessions: [child],
        hasActiveSubagentRun: true,
      };
      await expect(
        proxy.filterEvent(token, {
          event,
          payload: { sessionKey, ...row, session: row },
        }),
      ).resolves.toEqual({ event, payload: { sessionKey, ...expected, session: expected } });
      await expect(
        proxy.filterEvent(token, {
          event,
          payload: { sessionKey, ...row, childSessions: ["agent:other:child"] },
        }),
      ).resolves.toBeNull();
    },
  );

  it("clears parent activity when the authoritative snapshot has no remaining child links", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    const row = { key, activeChildSessions: [] };
    const expected = { key, hasActiveSubagentRun: false };
    request.mockResolvedValueOnce({ session: row });
    await expect(proxy.request(token, "sessions.describe", { key })).resolves.toEqual({
      session: expected,
    });
    await expect(
      proxy.filterEvent(token, {
        event: "sessions.changed",
        payload: { sessionKey: key, ...row, session: row },
      }),
    ).resolves.toEqual({
      event: "sessions.changed",
      payload: { sessionKey: key, ...expected, session: expected },
    });
    expect(row).toEqual({ key, activeChildSessions: [] });
  });

  it("retains legacy self-only flags and rejects malformed evidence envelopes", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    const legacy = { key, hasActiveSubagentRun: true };
    request.mockResolvedValueOnce({ session: legacy });
    await expect(proxy.request(token, "sessions.describe", { key })).resolves.toEqual({
      session: legacy,
    });
    for (const activeChildSessions of ["invalid", { key }, null]) {
      request.mockResolvedValueOnce({ session: { key, activeChildSessions } });
      await expect(proxy.request(token, "sessions.describe", { key })).rejects.toMatchObject({
        code: "upstream-result-denied",
      });
      await expect(
        proxy.filterEvent(token, {
          event: "session.message",
          payload: { sessionKey: key, activeChildSessions },
        }),
      ).resolves.toBeNull();
    }
  });

  it("separates Space lineage discovery from native access across membership revocation", async () => {
    const f = await createSpaceTestFixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const child = f.store.spaces.createConversation(f.alice.user.id, f.space.id, {
      pageId: f.page.id,
      title: "Owned child",
      requestId: "activity-child",
    });
    const key = `agent:${f.alice.binding.agentId}:main`;
    const raw = {
      key,
      childSessions: [child.sessionKey],
      activeChildSessions: [child.sessionKey],
      hasActiveSubagentRun: true,
    };
    const event = { event: "sessions.changed", payload: { sessionKey: key, ...raw } };
    const native = { key, childSessions: [child.sessionKey], hasActiveSubagentRun: true };
    f.request.mockResolvedValueOnce({ session: raw });
    await expect(f.proxy.request(f.alice.token, "sessions.describe", { key })).resolves.toEqual({
      session: native,
    });
    const personal = { sessionKey: key, key, childSessions: [], hasActiveSubagentRun: false };
    await expect(f.proxy.filterEvent(f.alice.token, event)).resolves.toEqual({
      event: "sessions.changed",
      payload: personal,
    });
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
    await expect(f.proxy.filterEvent(f.alice.token, event)).resolves.toEqual({
      event: "sessions.changed",
      payload: personal,
    });
    f.request.mockResolvedValueOnce({ session: raw });
    await expect(f.proxy.request(f.alice.token, "sessions.describe", { key })).resolves.toEqual({
      session: { key, childSessions: [], hasActiveSubagentRun: false },
    });
  });
});
