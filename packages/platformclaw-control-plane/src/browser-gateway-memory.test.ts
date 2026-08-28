import { describe, expect, it, vi } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy personal memory", () => {
  it("adds safe organization hits for the pinned agent without exposing storage paths", async () => {
    const searchOrganizationMemory = vi.fn(async () => [
      {
        id: "claim-1",
        path: "organization/team/claim-1",
        scopeKind: "team" as const,
        scopeId: "scope-1",
        scopeName: "Platform",
        title: "Release policy",
        snippet: "Production releases need two approvals.",
        score: 0.9,
        updatedAt: 1_000,
      },
    ]);
    const { binding, proxy, request, token } = await setup({ searchOrganizationMemory });
    request.mockResolvedValueOnce({
      agentId: binding.agentId,
      provider: "local",
      searchMode: "fts-only",
      results: [],
    });

    const response = await proxy.request<{ results: Array<Record<string, unknown>> }>(
      token,
      "memory.search",
      { query: "release" },
    );

    expect(searchOrganizationMemory).toHaveBeenCalledWith({
      agentId: binding.agentId,
      query: "release",
      maxResults: 20,
    });
    expect(response.results).toEqual([
      expect.objectContaining({
        source: "organization",
        path: "organization/team/claim-1",
        provenanceLabel: "Platform",
      }),
    ]);
    expect(JSON.stringify(response)).not.toContain("scope-1");
  });

  it("keeps personal results when organization memory is unavailable", async () => {
    const { binding, proxy, request, token } = await setup({
      searchOrganizationMemory: vi.fn(async () => {
        throw new Error("organization store offline");
      }),
    });
    request.mockResolvedValueOnce({
      agentId: binding.agentId,
      provider: "local",
      searchMode: "fts-only",
      results: [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 0.8,
          snippet: "Personal memory remains available.",
          source: "memory",
        },
      ],
    });

    await expect(proxy.request(token, "memory.search", { query: "memory" })).resolves.toEqual({
      agentId: binding.agentId,
      provider: "local",
      searchMode: "fts-only",
      organizationMemoryUnavailable: true,
      results: [expect.objectContaining({ path: "MEMORY.md" })],
    });
  });

  it("opens an authorized organization result without dispatching to the Gateway", async () => {
    const getOrganizationMemory = vi.fn(async () => ({
      id: "claim-1",
      path: "organization/group/claim-1",
      scopeKind: "group" as const,
      scopeId: "scope-1",
      scopeName: "Memory Group",
      title: "Release policy",
      snippet: "Use the reviewed checklist.",
      score: 1,
      updatedAt: 1_000,
      content: "# Release policy\nUse the reviewed checklist.",
      fromLine: 1,
      lineCount: 2,
    }));
    const { binding, proxy, request, token } = await setup({ getOrganizationMemory });

    await expect(
      proxy.request(token, "platformclaw.memory.get", {
        agentId: binding.agentId,
        path: "organization/group/claim-1",
      }),
    ).resolves.toEqual({
      path: "organization/group/claim-1",
      title: "Release policy",
      kind: "group",
      provenanceLabel: "Memory Group",
      content: "# Release policy\nUse the reviewed checklist.",
      fromLine: 1,
      lineCount: 2,
      updatedAt: "1970-01-01T00:00:01.000Z",
    });
    expect(getOrganizationMemory).toHaveBeenCalledWith({
      agentId: binding.agentId,
      path: "organization/group/claim-1",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("ranks combined personal and organization results within the browser cap", async () => {
    const { binding, proxy, request, token } = await setup({
      searchOrganizationMemory: vi.fn(async () => [
        {
          id: "policy",
          path: "organization/global/policy",
          scopeKind: "global" as const,
          scopeName: "Global",
          title: "Policy",
          snippet: "Company policy",
          score: 0.99,
          updatedAt: 1,
        },
      ]),
    });
    request.mockResolvedValueOnce({
      agentId: binding.agentId,
      provider: "local",
      searchMode: "fts-only",
      results: Array.from({ length: 50 }, (_, index) => ({
        path: index === 0 ? "MEMORY.md" : `memory/result-${index}.md`,
        startLine: 1,
        endLine: 1,
        score: 0.1,
        snippet: `Personal ${index}`,
        source: "memory",
      })),
    });

    const result = await proxy.request<{ results: Array<Record<string, unknown>> }>(
      token,
      "memory.search",
      { query: "policy" },
    );
    expect(result.results).toHaveLength(50);
    expect(result.results[0]).toMatchObject({ path: "organization/global/policy" });
  });
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
    await expect(
      proxy.request(token, "platformclaw.memory.get", {
        agentId: "other",
        path: "organization/group/claim-1",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    await expect(
      proxy.request(token, "platformclaw.memory.get", { path: "organization/group/../claim-1" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "platformclaw.memory.get", {
        path: "organization/group/claim-1",
        includeEvidence: true,
      }),
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
