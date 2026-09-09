import { describe, expect, it, vi } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy organization memory graph", () => {
  it("pins graph reads to the authenticated Agent and projects only safe fields", async () => {
    const getOrganizationMemoryGraph = vi.fn(async () => ({
      kind: "part" as const,
      nodes: [
        {
          id: "organization:part:claim-1",
          path: "organization/part/claim-1",
          title: "Release policy",
          scopeName: "Runtime",
          updatedAt: 1_000,
          absolutePath: "C:/private/control.sqlite",
          scopeId: "private-scope-id",
        },
      ],
      edges: [],
      stats: {
        totalPages: 1,
        totalNodes: 1,
        totalEdges: 0,
        truncated: false,
        partial: false,
        privateCount: 99,
      },
    }));
    const { binding, proxy, request, token } = await setup({ getOrganizationMemoryGraph });

    const result = await proxy.request(token, "platformclaw.memory.graph", { kind: "part" });

    expect(getOrganizationMemoryGraph).toHaveBeenCalledWith({
      agentId: binding.agentId,
      kind: "part",
    });
    expect(result).toEqual({
      kind: "part",
      nodes: [
        {
          id: "organization:part:claim-1",
          path: "organization/part/claim-1",
          title: "Release policy",
          scopeName: "Runtime",
          updatedAt: 1_000,
        },
      ],
      edges: [],
      stats: {
        totalPages: 1,
        totalNodes: 1,
        totalEdges: 0,
        truncated: false,
        partial: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-scope-id");
    expect(JSON.stringify(result)).not.toContain("C:/private");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects caller-selected authority and malformed projected payloads", async () => {
    const { proxy, request, token } = await setup({
      getOrganizationMemoryGraph: vi.fn(async () => ({
        kind: "group",
        nodes: [
          {
            id: "organization:group:claim-1",
            path: "C:/private/claim-1",
            title: "Private",
            scopeName: "Hidden",
            updatedAt: 1,
          },
        ],
        edges: [],
        stats: {
          totalPages: 1,
          totalNodes: 1,
          totalEdges: 0,
          truncated: false,
          partial: false,
        },
      })),
    });

    await expect(
      proxy.request(token, "platformclaw.memory.graph", { kind: "part", agentId: "other" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "platformclaw.memory.graph", { kind: "part", scopeId: "sibling" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "platformclaw.memory.graph", { kind: "team" }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    await expect(
      proxy.request(token, "platformclaw.memory.graph", { kind: "group" }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
    expect(request).not.toHaveBeenCalled();
  });
});
