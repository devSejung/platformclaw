import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

function checkpoint(sessionKey: string) {
  return {
    checkpointId: "checkpoint-1",
    sessionKey,
    sessionId: "session-1",
    createdAt: 1000,
    reason: "manual",
    tokensBefore: 100,
    tokensAfter: 50,
    summary: "Keep the decision",
    preCompaction: {
      sessionId: "session-1",
      leafId: "leaf-before",
      sessionFile: "/private/before",
    },
    postCompaction: { sessionId: "session-2", leafId: "leaf-after", sessionFile: "/private/after" },
  };
}

describe("BrowserGatewayProxy personal session reads", () => {
  it.each([
    ["sessions.branches.list", "sessionKey", {}],
    ["sessions.branches.switch", "sessionKey", { leafEntryId: "leaf-1" }],
    ["sessions.compaction.list", "key", {}],
    ["sessions.compaction.get", "key", { checkpointId: "checkpoint-1" }],
    ["sessions.compaction.branch", "key", { checkpointId: "checkpoint-1" }],
    ["sessions.compaction.restore", "key", { checkpointId: "checkpoint-1" }],
    ["sessions.usage.logs", "key", {}],
    ["sessions.usage.timeseries", "key", {}],
    ["artifacts.get", "sessionKey", { artifactId: "artifact-1" }],
  ] as const)(
    "rejects foreign and unscoped %s requests before dispatch",
    async (method, keyField, extra) => {
      const { binding, proxy, request, token } = await setup();
      for (const key of ["agent:other:main", "global", "main"]) {
        await expect(
          proxy.request(token, method, { [keyField]: key, ...extra }),
        ).rejects.toMatchObject({ code: "cross-agent-denied" });
      }
      await expect(
        proxy.request(token, method, {
          [keyField]: `agent:${binding.agentId}:main`,
          agentId: "other",
          ...extra,
        }),
      ).rejects.toMatchObject({ code: "cross-agent-denied" });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("lists and switches owned conversation branches without returning operator metadata", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:thread`;
    const branch = { leafEntryId: "leaf-1", headline: "Decision", messageCount: 3, active: false };
    request
      .mockResolvedValueOnce({ branches: [{ ...branch, sessionFile: "/private/transcript" }] })
      .mockResolvedValueOnce({ privatePath: "/private" });
    await expect(proxy.request(token, "sessions.branches.list", { sessionKey })).resolves.toEqual({
      branches: [branch],
    });
    await expect(
      proxy.request(token, "sessions.branches.switch", { sessionKey, leafEntryId: "leaf-1" }),
    ).resolves.toEqual({});
    expect(request).toHaveBeenLastCalledWith("sessions.branches.switch", {
      sessionKey,
      leafEntryId: "leaf-1",
      agentId: binding.agentId,
    });
  });

  it.each(["list", "get", "branch", "restore"])(
    "projects owned compaction %s results without transcript paths",
    async (operation) => {
      const { binding, proxy, request, token } = await setup();
      const key = `agent:${binding.agentId}:thread`;
      const nextKey = operation === "branch" ? `agent:${binding.agentId}:branch` : key;
      const rawCheckpoint = checkpoint(key);
      request.mockResolvedValue({
        ok: true,
        key: nextKey,
        sourceKey: key,
        sessionId: "session-2",
        checkpoint: rawCheckpoint,
        checkpoints: [rawCheckpoint],
        entry: {
          sessionId: "session-2",
          updatedAt: 2000,
          sessionFile: "/private/entry",
          token: "hidden",
        },
        path: "/private/store",
      });
      const result = await proxy.request<Record<string, unknown>>(
        token,
        `sessions.compaction.${operation}`,
        {
          key,
          ...(operation === "list" ? {} : { checkpointId: "checkpoint-1" }),
        },
      );
      expect(result.key).toBe(nextKey);
      expect(JSON.stringify(result)).not.toContain("/private");
      expect(JSON.stringify(result)).not.toContain("hidden");
      if (operation === "list") {
        expect(result.checkpoints).toEqual([
          {
            ...rawCheckpoint,
            preCompaction: { sessionId: "session-1", leafId: "leaf-before" },
            postCompaction: { sessionId: "session-2", leafId: "leaf-after" },
          },
        ]);
      } else if (operation !== "get") {
        expect(result.entry).toEqual({ sessionId: "session-2", updatedAt: 2000 });
      }
      expect(request).toHaveBeenCalledWith(
        `sessions.compaction.${operation}`,
        expect.objectContaining({
          key,
          agentId: binding.agentId,
        }),
      );
    },
  );

  it("rejects cross-owner checkpoint metadata and newly created keys", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:thread`;
    request
      .mockResolvedValueOnce({ ok: true, key, checkpoints: [checkpoint("agent:other:thread")] })
      .mockResolvedValueOnce({ ok: true, key: "agent:other:branch", sourceKey: key });
    await expect(proxy.request(token, "sessions.compaction.list", { key })).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
    await expect(
      proxy.request(token, "sessions.compaction.branch", { key, checkpointId: "checkpoint-1" }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
  });

  it("keeps owned historical usage keys and projects only chart and log fields", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:historical-session-id`;
    const point = {
      timestamp: 100,
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: 0.1,
      cumulativeTokens: 3,
      cumulativeCost: 0.1,
    };
    const log = { timestamp: 100, role: "assistant", content: "Owned reply", tokens: 3, cost: 0.1 };
    request
      .mockResolvedValueOnce({
        sessionId: "historical-session-id",
        points: [{ ...point, path: "/private" }],
      })
      .mockResolvedValueOnce({ logs: [{ ...log, path: "/private" }] });
    await expect(proxy.request(token, "sessions.usage.timeseries", { key })).resolves.toEqual({
      sessionId: "historical-session-id",
      points: [point],
    });
    await expect(
      proxy.request(token, "sessions.usage.logs", { key, limit: 1000 }),
    ).resolves.toEqual({ logs: [log] });
    expect(request).toHaveBeenLastCalledWith("sessions.usage.logs", {
      key,
      limit: 1000,
      agentId: binding.agentId,
    });
  });

  it("gets an owned artifact summary and rejects mismatched artifact ids", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:thread`;
    const artifact = {
      id: "artifact-1",
      sessionKey,
      type: "file",
      title: "report.pdf",
      download: { mode: "bytes" },
    };
    request
      .mockResolvedValueOnce({
        artifact: {
          ...artifact,
          privatePath: "/private",
          download: { mode: "bytes", sessionFile: "/private" },
        },
      })
      .mockResolvedValueOnce({ artifact: { ...artifact, id: "other" } });
    await expect(
      proxy.request(token, "artifacts.get", { sessionKey, artifactId: "artifact-1" }),
    ).resolves.toEqual({ artifact });
    await expect(
      proxy.request(token, "artifacts.get", { sessionKey, artifactId: "artifact-1" }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
  });

  it("pins provider quota reads and removes account, billing and error details", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValue({
      updatedAt: 100,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          accountEmail: "private@example.test",
          plan: "Private",
          billing: [{ amount: 20, unit: "USD" }],
          costHistory: { scope: "account" },
          error: "Token for private@example.test expired",
          windows: [{ label: "5h", usedPercent: 70, resetAt: 200 }],
        },
      ],
    });
    await expect(proxy.request(token, "usage.status", {})).resolves.toEqual({
      updatedAt: 100,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          error: "Provider usage is unavailable",
          windows: [{ label: "5h", usedPercent: 70, resetAt: 200 }],
        },
      ],
    });
    expect(request).toHaveBeenCalledWith("usage.status", { agentId: binding.agentId });
    await expect(proxy.request(token, "usage.status", { agentId: "other" })).rejects.toMatchObject({
      code: "cross-agent-denied",
    });
  });

  it("returns a bounded GitHub preview for the requested public link", async () => {
    const { proxy, request, token } = await setup();
    const target = { kind: "pull", owner: "openclaw", repo: "openclaw", number: 42 };
    const preview = {
      ...target,
      title: "Fix",
      login: "contributor",
      state: "open",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
    };
    request
      .mockResolvedValueOnce({
        ...preview,
        privateCredential: "hidden",
        url: "https://private.test",
      })
      .mockResolvedValueOnce({ ...preview, number: 43 });
    await expect(proxy.request(token, "controlUi.githubPreview", target)).resolves.toEqual(preview);
    expect(request).toHaveBeenCalledWith("controlUi.githubPreview", target);
    await expect(proxy.request(token, "controlUi.githubPreview", target)).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
  });
});
