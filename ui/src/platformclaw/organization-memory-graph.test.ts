/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./organization-memory-graph.ts";

type GraphElement = HTMLElement & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  methodAdvertised: boolean;
  getAdvertised: boolean;
  inventoryAdvertised: boolean;
  agentId: string | null;
  updateComplete: Promise<unknown>;
};

function createGraph(request: (method: string, params: unknown) => Promise<unknown>) {
  const element = document.createElement("platformclaw-organization-memory-graph") as GraphElement;
  element.client = {
    request: (method: string, params: unknown) =>
      method === "platformclaw.memory.lifecycle"
        ? Promise.resolve({
            scopes: [
              { kind: "part", id: "part-1", name: "Runtime", canRead: true, canAdminister: false },
              { kind: "group", id: "group-1", name: "Platform", canRead: true },
              { kind: "team", id: "team-1", name: "Team", canRead: true },
            ],
          })
        : request(method, params),
  } as unknown as GatewayBrowserClient;
  element.connected = true;
  element.methodAdvertised = true;
  element.getAdvertised = true;
  element.inventoryAdvertised = true;
  element.agentId = "personal-agent";
  document.body.append(element);
  return element;
}

function graph(kind: "part" | "group" | "team" | "global", title = `${kind} knowledge`) {
  return {
    kind,
    nodes: [
      {
        id: `organization:${kind}:claim-1`,
        path: `organization/${kind}/claim-1`,
        title,
        scopeName: kind === "part" ? "Runtime" : "Platform",
        updatedAt: 1,
        verification: {
          approvalStatus: "approved" as const,
          revision: 3,
          sourceRevision: 2,
          sourceStatus: "current" as const,
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
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PlatformClawOrganizationMemoryGraph", () => {
  it("selects only readable scopes and never falls back to an aggregate graph", async () => {
    let scopes = [
      { kind: "part", id: "p1", name: "Part One", canRead: true },
      { kind: "part", id: "p2", name: "Part Two", canRead: true },
      { kind: "part", id: "managed-only", name: "Management only", canRead: false },
      { kind: "group", id: "g1", name: "Own Group", canRead: true },
      { kind: "team", id: "t1", name: "Own Team", canRead: true },
    ];
    const request = vi.fn(async (method: string, params: unknown) =>
      method === "platformclaw.memory.lifecycle"
        ? { scopes }
        : graph(
            (params as { kind: "part" | "group" | "team" | "global" }).kind,
            JSON.stringify(params),
          ),
    );
    const element = createGraph(request);
    element.client = { request } as unknown as GatewayBrowserClient;
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.memory.graph", {
        kind: "part",
        scopeId: "p1",
      }),
    );
    expect(element.querySelectorAll("select option")).toHaveLength(2);
    expect(element.textContent).not.toContain("Management only");
    const select = element.querySelector<HTMLSelectElement>("select")!;
    select.value = "p2";
    select.dispatchEvent(new Event("change"));
    await waitForFast(() =>
      expect(
        element.querySelector("[data-organization-node]")?.getAttribute("aria-label"),
      ).toContain('"scopeId":"p2"'),
    );
    expect(element.textContent).not.toContain('"scopeId":"p1"');
    for (const [kind, scopeId] of [
      ["group", "g1"],
      ["team", "t1"],
    ]) {
      element
        .querySelector<HTMLButtonElement>("#organization-memory-graph-kind-tab-" + kind)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("platformclaw.memory.graph", { kind, scopeId }),
      );
      await waitForFast(() =>
        expect(element.querySelector<HTMLSelectElement>("select")!.value).toBe(scopeId),
      );
    }
    element
      .querySelector<HTMLButtonElement>("#organization-memory-graph-kind-tab-global")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.memory.graph", { kind: "global" }),
    );
    expect(element.querySelector("select")).toBeNull();
    scopes = [];
    element.agentId = "unrelated";
    await waitForFast(() =>
      expect(
        element
          .querySelector(".organization-memory-graph__header button")!
          .getAttribute("disabled"),
      ).toBeNull(),
    );
    element
      .querySelector<HTMLButtonElement>("#organization-memory-graph-kind-tab-part")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() =>
      expect(element.querySelector<HTMLSelectElement>("select")!.disabled).toBe(true),
    );
    expect(element.querySelectorAll("select option")).toHaveLength(0);
    expect(
      request.mock.calls.some(
        ([method, params]) =>
          method === "platformclaw.memory.graph" &&
          (params as { kind: string; scopeId?: string }).kind === "part" &&
          !(params as { scopeId?: string }).scopeId,
      ),
    ).toBe(false);
  });
  it("renders explicit reference arrows separately from inferred comparisons", async () => {
    const base = graph("part");
    const referenceGraph = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          ...base.nodes[0],
          id: "reference-target",
          path: "organization/part/reference-target",
          title: "Referenced knowledge",
        },
      ],
      edges: [
        { source: "reference-target", target: base.nodes[0].id, type: "promotion" },
        {
          source: base.nodes[0].id,
          target: "reference-target",
          type: "reference",
          sourceRevision: 3,
          targetRevision: 2,
          inputStatus: "current",
        },
      ],
    };
    const element = createGraph(async () => referenceGraph);
    await waitForFast(() =>
      expect(element.querySelector('line[data-edge-type="reference"]')).not.toBeNull(),
    );
    const line = element.querySelector('line[data-edge-type="reference"]')!;
    expect(line.getAttribute("marker-end")).toBe("url(#organization-memory-reference-arrow)");
    const promotion = element.querySelector('line[data-edge-type="promotion"]')!;
    expect([line.getAttribute("x1"), line.getAttribute("y1")]).not.toEqual([
      promotion.getAttribute("x2"),
      promotion.getAttribute("y2"),
    ]);
    line.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await element.updateComplete;
    expect(
      element
        .querySelector(".organization-memory-graph__edge-detail")
        ?.textContent?.replace(/\s+/g, " "),
    ).toContain("Referenced knowledge · r2");
  });
  it("distinguishes inferred undirected comparison edges and opens their keyboard details", async () => {
    const base = graph("part");
    const comparisonGraph = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          ...base.nodes[0],
          id: "organization:part:claim-2",
          path: "organization/part/claim-2",
          title: "Version two",
        },
      ],
      edges: [
        {
          source: "organization:part:claim-1",
          target: "organization:part:claim-2",
          type: "comparison",
          kind: "condition-difference",
          summary: "Different board versions",
          reportId: "report-1",
          completedAt: Date.now(),
          inputStatus: "current",
          reviewStatus: "kept",
          claimRevisions: [
            { id: "claim-1", revision: 3 },
            { id: "claim-2", revision: 1 },
          ],
        },
      ],
      stats: { ...base.stats, totalNodes: 2, totalEdges: 1 },
    };
    const request = vi.fn(
      async (_method: string, params: { kind: "part" | "group" | "team" | "global" }) =>
        params.kind === "part" ? comparisonGraph : graph("group"),
    );
    const element = createGraph(request);
    await waitForFast(() =>
      expect(element.querySelector('line[data-edge-type="comparison"]')).not.toBeNull(),
    );
    const edge = element.querySelector('line[data-edge-type="comparison"]')!;
    expect(edge.hasAttribute("marker-end")).toBe(false);
    expect(edge.getAttribute("aria-label")).toContain("Condition difference");
    edge.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitForFast(() =>
      expect(
        element.querySelector(".organization-memory-graph__edge-detail")?.textContent,
      ).toContain("Different board versions"),
    );
    expect(element.querySelector(".organization-memory-graph__edge-detail")?.textContent).toContain(
      "Kept separately",
    );
    expect(request.mock.calls.every((call) => call[0] === "platformclaw.memory.graph")).toBe(true);
    const select = (kind: "part" | "group" | "team" | "global") =>
      element
        .querySelector(`#organization-memory-graph-kind-tab-${kind}`)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    select("group");
    await waitForFast(() =>
      expect(
        element.querySelector('[data-organization-node="organization/group/claim-1"]'),
      ).not.toBeNull(),
    );
    select("part");
    await waitForFast(() =>
      expect(element.querySelector('line[data-edge-type="comparison"]')).not.toBeNull(),
    );
    element
      .querySelector('line[data-edge-type="comparison"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitForFast(() =>
      expect(element.querySelector(".organization-memory-graph__edge-detail")).not.toBeNull(),
    );
    select("group");
    await waitForFast(() =>
      expect(element.querySelector(".organization-memory-graph__edge-detail")).toBeNull(),
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("loads Part and Group separately and opens nodes through the existing organization preview RPC", async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "platformclaw.memory.graph") {
        const kind = (params as { kind: "part" | "group" | "team" | "global" }).kind;
        return graph(kind);
      }
      return {
        id: "claim-1",
        path: "organization/group/claim-1",
        kind: "group",
        provenanceLabel: "Platform",
        title: "group knowledge",
        snippet: "Shared guidance",
        score: 1,
        updatedAt: 1,
        verification: {
          approvalStatus: "approved",
          revision: 4,
          sourceRevision: 2,
          sourceStatus: "current",
        },
        content: "# Shared guidance",
        fromLine: 1,
        lineCount: 1,
      };
    });
    const element = createGraph(request);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.memory.graph", {
        kind: "part",
        scopeId: "part-1",
      }),
    );
    expect(
      element.querySelector('[data-organization-node="organization/part/claim-1"]'),
    ).not.toBeNull();

    element
      .querySelector("#organization-memory-graph-kind-tab-group")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.memory.graph", {
        kind: "group",
        scopeId: "group-1",
      }),
    );
    await waitForFast(() =>
      expect(
        element.querySelector('[data-organization-node="organization/group/claim-1"]'),
      ).not.toBeNull(),
    );
    const node = element.querySelector<SVGGElement>(
      '[data-organization-node="organization/group/claim-1"]',
    )!;
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.memory.get", {
        agentId: "personal-agent",
        path: "organization/group/claim-1",
        fromLine: 1,
        lineCount: 200,
      }),
    );
    await waitForFast(() =>
      expect(element.querySelector(".wiki-document__reader h1")?.textContent).toBe(
        "Shared guidance",
      ),
    );
    expect(element.querySelector("[data-memory-verification]")?.textContent).toContain("4");
    expect(element.querySelector("[data-memory-verification]")?.textContent).toContain("2");
  });

  it("zooms and drags nodes without opening the preview", async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "platformclaw.memory.graph") {
        return graph((params as { kind: "part" }).kind);
      }
      return null;
    });
    const element = createGraph(request);
    await waitForFast(() => expect(element.querySelector("[data-svg-graph-node]")).not.toBeNull());
    const svg = element.querySelector(".organization-memory-graph__canvas svg")!;
    const node = element.querySelector<SVGGElement>("[data-svg-graph-node]")!;
    const event = (type: string, x: number, y: number) =>
      Object.assign(new Event(type, { bubbles: true }), {
        button: 0,
        clientX: x,
        clientY: y,
        isPrimary: true,
        pointerId: 1,
      });
    node.dispatchEvent(event("pointerdown", 10, 10));
    svg.dispatchEvent(event("pointermove", 40, 40));
    svg.dispatchEvent(event("pointerup", 40, 40));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(request.mock.calls.some(([method]) => method === "platformclaw.memory.get")).toBe(false);

    element.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
    expect(element.querySelector("[data-svg-graph-viewport]")?.getAttribute("transform")).toContain(
      "scale(1.2)",
    );
  });

  it("renders empty, partial, error, and unavailable states", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("store offline"))
      .mockResolvedValueOnce({
        kind: "part",
        nodes: [],
        edges: [],
        stats: {
          totalPages: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          partial: true,
        },
      });
    const element = createGraph(request);
    await waitForFast(() => expect(element.textContent).toContain("store offline"));
    [...element.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Try again")!
      .click();
    await waitForFast(() => expect(element.textContent).toContain("No published knowledge yet"));
    expect(element.textContent).toContain("Some relation data is unavailable");

    element.methodAdvertised = false;
    await element.updateComplete;
    expect(element.textContent).toContain("requires a newer PlatformClaw Gateway");
  });
});
