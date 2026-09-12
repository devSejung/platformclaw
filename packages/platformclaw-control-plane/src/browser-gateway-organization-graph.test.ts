import { describe, expect, it, vi } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";
import type { OrganizationMemoryGraph } from "./contracts.js";
import { ControlPlaneAuthorizationError } from "./contracts.js";

function inferredGraph(): OrganizationMemoryGraph {
  return {
    kind: "part",
    nodes: ["a", "b"].map((id) => ({
      id: `organization:part:${id}`,
      path: `organization/part/${id}`,
      title: `${id} conditions`,
      scopeName: "Runtime",
      updatedAt: 100,
      verification: {
        approvalStatus: "approved",
        revision: 1,
        sourceRevision: 1,
        sourceStatus: "unavailable",
      },
    })),
    edges: [
      {
        source: "organization:part:a",
        target: "organization:part:b",
        type: "comparison",
        kind: "condition-difference",
        summary: "Version alpha and beta use distinct procedures.",
        reportId: "report-fixture",
        completedAt: 100,
        inputStatus: "current",
        reviewStatus: "kept",
        claimRevisions: [
          { id: "a", revision: 1 },
          { id: "b", revision: 1 },
        ],
      },
    ],
    stats: { totalPages: 2, totalNodes: 2, totalEdges: 1, truncated: false, partial: false },
  };
}

describe("BrowserGatewayProxy organization memory graph", () => {
  it.each(["team", "global"] as const)(
    "projects authorized %s graphs and preserves directed provenance",
    async (kind) => {
      const graph: OrganizationMemoryGraph = {
        ...inferredGraph(),
        kind,
        nodes: inferredGraph().nodes.map((node) =>
          Object.assign(node, {
            id: node.id.replace(":part:", `:${kind}:`),
            path: node.path.replace("/part/", `/${kind}/`),
          }),
        ),
        edges: [
          { type: "promotion", source: `organization:${kind}:a`, target: `organization:${kind}:b` },
        ],
      };
      const get = vi.fn(async () => graph);
      const { proxy, token } = await setup({ getOrganizationMemoryGraph: get });
      await expect(proxy.request(token, "platformclaw.memory.graph", { kind })).resolves.toEqual(
        graph,
      );
      if (kind === "global") {
        await expect(
          proxy.request(token, "platformclaw.memory.graph", { kind, scopeId: "scope" }),
        ).rejects.toMatchObject({ code: "invalid-params" });
        expect(get).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("pins explicit scope selection, requires matching owner scope and denies unavailable scopes", async () => {
    const graph = { ...inferredGraph(), scopeId: "scope-part" };
    const get = vi.fn(async () => graph);
    const { proxy, token, binding } = await setup({ getOrganizationMemoryGraph: get });
    await expect(
      proxy.request(token, "platformclaw.memory.graph", { kind: "part", scopeId: graph.scopeId }),
    ).resolves.toEqual(graph);
    expect(get).toHaveBeenCalledWith({
      agentId: binding.agentId,
      kind: "part",
      scopeId: graph.scopeId,
    });
    await expect(
      proxy.request(token, "platformclaw.memory.graph", { kind: "part", scopeId: "other" }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
    get.mockRejectedValueOnce(
      new ControlPlaneAuthorizationError("selected graph scope is unavailable"),
    );
    await expect(
      proxy.request(token, "platformclaw.memory.graph", { kind: "part", scopeId: "unavailable" }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
  });
  it.each([null, "", " ", " scope-part", 3, true])(
    "rejects malformed selected scope %s before owner dispatch",
    async (scopeId) => {
      const get = vi.fn(async () => inferredGraph());
      const { proxy, token } = await setup({ getOrganizationMemoryGraph: get });
      await expect(
        proxy.request(token, "platformclaw.memory.graph", { kind: "part", scopeId }),
      ).rejects.toMatchObject({ code: "invalid-params" });
      expect(get).not.toHaveBeenCalled();
    },
  );
  it("projects bounded inferred relations with exact visible pinned revisions and separate human status", async () => {
    const graph = inferredGraph();
    const { proxy, token } = await setup({ getOrganizationMemoryGraph: vi.fn(async () => graph) });
    const result = await proxy.request(token, "platformclaw.memory.graph", { kind: "part" });
    expect(result).toEqual(graph);
    expect(JSON.stringify(result)).toContain('"reviewStatus":"kept"');
    expect(JSON.stringify(result)).toContain('"type":"comparison"');
  });

  it.each(["stale-revision", "uncertainty", "rejected", "unknown-node", "promotion-overlap"])(
    "rejects unsafe inferred graph %s",
    async (fault) => {
      const graph = inferredGraph();
      const edge = graph.edges[0]!;
      if (edge.type !== "comparison") {
        throw new Error("missing comparison fixture");
      }
      if (fault === "stale-revision") {
        edge.claimRevisions[0]!.revision = 2;
      }
      if (fault === "uncertainty") {
        Object.assign(edge, { kind: "insufficient-evidence" });
      }
      if (fault === "rejected") {
        Object.assign(edge, { reviewStatus: "rejected" });
      }
      if (fault === "unknown-node") {
        edge.target = "organization:part:private";
      }
      if (fault === "promotion-overlap") {
        graph.edges.push({ source: edge.target, target: edge.source, type: "promotion" });
        graph.stats.totalEdges = 2;
      }
      const { proxy, token } = await setup({
        getOrganizationMemoryGraph: vi.fn(async () => graph),
      });
      await expect(
        proxy.request(token, "platformclaw.memory.graph", { kind: "part" }),
      ).rejects.toMatchObject({ code: "upstream-result-denied" });
    },
  );
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
          verification: {
            approvalStatus: "approved" as const,
            revision: 2,
            sourceRevision: 1,
            sourceStatus: "unavailable" as const,
            sourceClaimId: "private-source",
          },
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
          verification: {
            approvalStatus: "approved",
            revision: 2,
            sourceRevision: 1,
            sourceStatus: "unavailable",
          },
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
    expect(JSON.stringify(result)).not.toContain("private-source");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects caller-selected authority and malformed projected payloads", async () => {
    const { proxy, request, token } = await setup({
      getOrganizationMemoryGraph: vi.fn(async () => ({
        kind: "group" as const,
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
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
    await expect(
      proxy.request(token, "platformclaw.memory.graph", { kind: "invalid" }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    await expect(
      proxy.request(token, "platformclaw.memory.graph", { kind: "group" }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
    expect(request).not.toHaveBeenCalled();
  });
});
