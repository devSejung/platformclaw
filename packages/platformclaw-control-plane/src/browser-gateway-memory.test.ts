import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy personal memory", () => {
  it("pins searches to the personal Agent and projects only canonical memory documents", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      agentId: binding.agentId,
      provider: "local",
      searchMode: "hybrid",
      stale: true,
      warning: "/private/index is rebuilding",
      results: [
        {
          path: "memory/people/ada.md",
          startLine: 2,
          endLine: 3,
          score: 0.91,
          snippet: "Ada prefers careful reviews.",
          source: "memory",
          projectKey: "private-project-key",
        },
        {
          path: "sessions/foreign.jsonl",
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet: "private transcript",
          source: "sessions",
        },
      ],
    });

    await expect(
      proxy.request(token, "memory.search", { query: "  Ada  ", agentId: binding.agentId }),
    ).resolves.toEqual({
      agentId: binding.agentId,
      provider: "local",
      searchMode: "hybrid",
      stale: true,
      results: [
        {
          path: "memory/people/ada.md",
          startLine: 2,
          endLine: 3,
          score: 0.91,
          snippet: "Ada prefers careful reviews.",
          source: "memory",
        },
      ],
    });
    expect(request).toHaveBeenCalledWith("memory.search", {
      query: "Ada",
      agentId: binding.agentId,
    });
  });

  it("reads only personal memory Markdown and removes workspace metadata", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      agentId: binding.agentId,
      workspace: "/srv/private/agent",
      file: {
        path: "memory/people/ada.md",
        name: "wrong-name.md",
        size: 31,
        updatedAtMs: 2,
        mimeType: "application/private",
        encoding: "utf8",
        content: "# Ada\nPrefers careful reviews.",
      },
    });

    await expect(
      proxy.request(token, "agents.workspace.get", {
        path: "memory\\people\\ada.md",
        agentId: binding.agentId,
      }),
    ).resolves.toEqual({
      agentId: binding.agentId,
      file: {
        path: "memory/people/ada.md",
        name: "ada.md",
        size: 31,
        updatedAtMs: 2,
        mimeType: "text/plain",
        encoding: "utf8",
        content: "# Ada\nPrefers careful reviews.",
      },
    });
    expect(request).toHaveBeenCalledWith("agents.workspace.get", {
      agentId: binding.agentId,
      path: "memory/people/ada.md",
    });
  });

  it("denies cross-Agent, arbitrary workspace, and future-parameter requests before dispatch", async () => {
    const { proxy, request, token } = await setup();

    await expect(
      proxy.request(token, "memory.search", { query: "Ada", agentId: "other" }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    await expect(
      proxy.request(token, "agents.workspace.get", { path: "AGENTS.md" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "agents.workspace.get", { path: "memory/../secrets.md" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "memory.search", { query: "Ada", includeSessions: true }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed on foreign or malformed Gateway memory results", async () => {
    const { binding, proxy, request, token } = await setup();
    request
      .mockResolvedValueOnce({
        agentId: "other",
        provider: "local",
        searchMode: "hybrid",
        results: [],
      })
      .mockResolvedValueOnce({
        agentId: binding.agentId,
        file: {
          path: "memory/other.md",
          encoding: "utf8",
          content: "wrong file",
        },
      });

    await expect(proxy.request(token, "memory.search", { query: "Ada" })).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
    await expect(
      proxy.request(token, "agents.workspace.get", { path: "MEMORY.md" }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
  });
});
