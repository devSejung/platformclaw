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

function firstNode(value: ReturnType<typeof graph>) {
  const node = value.nodes[0];
  if (!node) {
    throw new Error("graph fixture requires one node");
  }
  return node;
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
    expect(
      element.querySelectorAll(".organization-memory-graph__scope select option"),
    ).toHaveLength(2);
    expect(element.textContent).not.toContain("Management only");
    const select = element.querySelector<HTMLSelectElement>(
      ".organization-memory-graph__scope select",
    )!;
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
        expect(
          element.querySelector<HTMLSelectElement>(".organization-memory-graph__scope select")!
            .value,
        ).toBe(scopeId),
      );
    }
    element
      .querySelector<HTMLButtonElement>("#organization-memory-graph-kind-tab-global")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.memory.graph", { kind: "global" }),
    );
    expect(element.querySelector(".organization-memory-graph__scope select")).toBeNull();
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
      expect(
        element.querySelector<HTMLSelectElement>(".organization-memory-graph__scope select")!
          .disabled,
      ).toBe(true),
    );
    expect(
      element.querySelectorAll(".organization-memory-graph__scope select option"),
    ).toHaveLength(0);
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
    const baseNode = firstNode(base);
    const referenceGraph = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          ...baseNode,
          id: "reference-target",
          path: "organization/part/reference-target",
          title: "Referenced knowledge",
        },
      ],
      edges: [
        { source: "reference-target", target: baseNode.id, type: "promotion" },
        {
          source: baseNode.id,
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
    const referenceFilter = element.querySelector<HTMLInputElement>(
      '.organization-memory-graph__filters label[data-relation-type="reference"] input',
    )!;
    referenceFilter.checked = false;
    referenceFilter.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector('line[data-edge-type="reference"]')).toBeNull();
    expect(element.querySelector(".organization-memory-graph__edge-detail")).toBeNull();
  });
  it("distinguishes inferred undirected comparison edges and opens their keyboard details", async () => {
    const base = graph("part");
    const baseNode = firstNode(base);
    const comparisonGraph = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          ...baseNode,
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
    const request = vi.fn(async (_method: string, params: unknown) => {
      const kind = (params as { kind: "part" | "group" | "team" | "global" }).kind;
      return kind === "part" ? comparisonGraph : graph("group");
    });
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
  it("loads Part and Group separately, selects without reading, then explicitly opens the pinned document", async () => {
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
    await element.updateComplete;
    expect(node.getAttribute("aria-pressed")).toBe("true");
    expect(request.mock.calls.some(([method]) => method === "platformclaw.memory.get")).toBe(false);
    expect(element.querySelector(".organization-memory-graph__inspector")?.textContent).toContain(
      "group knowledge",
    );
    const open = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Open document",
    );
    expect(open).toBeInstanceOf(HTMLButtonElement);
    open!.click();
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
    const readerVerification = element.querySelector(
      ".organization-memory-graph__preview [data-memory-verification]",
    );
    expect(readerVerification?.textContent).toContain("4");
    expect(readerVerification?.textContent).toContain("2");
  });

  it("filters the graph locally, clears hidden selection, and can restrict to connected documents", async () => {
    const base = graph("part", "Alpha rollout policy");
    const first = firstNode(base);
    const filteredGraph = {
      ...base,
      nodes: [
        ...base.nodes,
        { ...first, id: "beta", path: "organization/part/beta", title: "Beta incident guide" },
        { ...first, id: "gamma", path: "organization/part/gamma", title: "Gamma release notes" },
      ],
      edges: [
        {
          source: first.id,
          target: "beta",
          type: "reference" as const,
          sourceRevision: 3,
          targetRevision: 3,
          inputStatus: "current" as const,
        },
        { source: "beta", target: "gamma", type: "promotion" as const },
      ],
      stats: { ...base.stats, totalPages: 3, totalNodes: 3, totalEdges: 2 },
    };
    const request = vi.fn(async () => filteredGraph);
    const element = createGraph(request);
    await waitForFast(() =>
      expect(element.querySelectorAll("[data-organization-node]")).toHaveLength(3),
    );

    element
      .querySelector<SVGGElement>(`[data-svg-graph-node="${first.id}"]`)!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await element.updateComplete;
    expect(
      element.querySelector(`[data-svg-graph-node="${first.id}"]`)?.getAttribute("aria-pressed"),
    ).toBe("true");
    const connected = [...element.querySelectorAll<HTMLLabelElement>("label")].find((label) =>
      label.textContent?.includes("Show only connected documents"),
    )!;
    const connectedInput = connected.querySelector("input") as HTMLInputElement;
    connectedInput.checked = true;
    connectedInput.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-organization-node]")).toHaveLength(2);
    expect(element.querySelector('[data-svg-graph-node="gamma"]')).toBeNull();

    const search = element.querySelector<HTMLInputElement>(
      ".organization-memory-graph__search input",
    )!;
    search.value = "Gamma";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-organization-node]")).toHaveLength(1);
    expect(element.querySelector('[data-svg-graph-node="gamma"]')).not.toBeNull();
    expect(element.querySelector('[aria-pressed="true"][data-svg-graph-node]')).toBeNull();

    search.value = "no match";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-organization-node]")).toHaveLength(0);
    [...element.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Clear search")!
      .click();
    await element.updateComplete;
    expect(element.querySelectorAll("[data-organization-node]")).toHaveLength(3);
  });

  it("filters edge types without writes and keeps the document picker aligned with visible nodes", async () => {
    const base = graph("part");
    const first = firstNode(base);
    const edgeGraph = {
      ...base,
      nodes: [
        ...base.nodes,
        { ...first, id: "second", path: "organization/part/second", title: "Second policy" },
      ],
      edges: [
        {
          source: first.id,
          target: "second",
          type: "reference" as const,
          sourceRevision: 3,
          targetRevision: 3,
          inputStatus: "current" as const,
        },
        { source: first.id, target: "second", type: "promotion" as const },
      ],
      stats: { ...base.stats, totalPages: 2, totalNodes: 2, totalEdges: 2 },
    };
    const request = vi.fn(async () => edgeGraph);
    const element = createGraph(request);
    await waitForFast(() =>
      expect(element.querySelectorAll(".organization-memory-graph__edges line")).toHaveLength(2),
    );
    expect(
      [
        ...element.querySelectorAll<HTMLOptionElement>(".organization-memory-graph__picker option"),
      ].map((option) => option.textContent?.trim()),
    ).toContain("Second policy");

    const reference = element.querySelector<HTMLInputElement>(
      '.organization-memory-graph__filters label[data-relation-type="reference"] input',
    )!;
    reference.checked = false;
    reference.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector('line[data-edge-type="reference"]')).toBeNull();
    expect(element.querySelector('line[data-edge-type="promotion"]')).not.toBeNull();
    expect(request.mock.calls.some(([method]) => method.includes("promotion"))).toBe(false);
  });

  it("disables document reads when the read capability is unavailable", async () => {
    const request = vi.fn(async () => graph("part"));
    const element = createGraph(request);
    element.getAdvertised = false;
    await waitForFast(() =>
      expect(element.querySelector("[data-organization-node]")).not.toBeNull(),
    );
    element
      .querySelector<SVGGElement>("[data-organization-node]")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await element.updateComplete;
    const open = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Open document",
    )!;
    expect(open.disabled).toBe(true);
    open.click();
    expect(request.mock.calls.some(([method]) => method === "platformclaw.memory.get")).toBe(false);
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

    const viewport = element.querySelector("[data-svg-graph-viewport]")!;
    const beforeZoom = Number(viewport.getAttribute("transform")?.match(/scale\(([^)]+)\)/u)?.[1]);
    element.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
    const afterZoom = Number(viewport.getAttribute("transform")?.match(/scale\(([^)]+)\)/u)?.[1]);
    expect(afterZoom).toBeCloseTo(beforeZoom * 1.2, 8);
    [...element.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Fit graph")!
      .click();
    expect(element.querySelector("[data-svg-graph-viewport]")?.getAttribute("transform")).toContain(
      "scale(",
    );
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await element.updateComplete;
    [...element.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Focus selection")!
      .click();
    expect(element.querySelector("[data-svg-graph-viewport]")?.getAttribute("transform")).toContain(
      "translate(",
    );
    [...element.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Enlarge graph")!
      .click();
    await element.updateComplete;
    expect(element.querySelector(".organization-memory-graph--expanded")).not.toBeNull();
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

  it("renders the offline state without requesting inventory or graph data", async () => {
    const request = vi.fn(async () => graph("part"));
    const element = createGraph(request);
    await waitForFast(() =>
      expect(element.querySelector("[data-organization-node]")).not.toBeNull(),
    );
    request.mockClear();
    element.connected = false;
    await element.updateComplete;
    expect(element.textContent).toContain(
      "Reconnect to the Gateway to load organization knowledge.",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
