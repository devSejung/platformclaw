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
  agentId: string | null;
  updateComplete: Promise<unknown>;
};

function createGraph(request: (method: string, params: unknown) => Promise<unknown>) {
  const element = document.createElement("platformclaw-organization-memory-graph") as GraphElement;
  element.client = { request } as unknown as GatewayBrowserClient;
  element.connected = true;
  element.methodAdvertised = true;
  element.getAdvertised = true;
  element.agentId = "personal-agent";
  document.body.append(element);
  return element;
}

function graph(kind: "part" | "group", title = `${kind} knowledge`) {
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
  it("loads Part and Group separately and opens nodes through the existing organization preview RPC", async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "platformclaw.memory.graph") {
        const kind = (params as { kind: "part" | "group" }).kind;
        return graph(kind);
      }
      return {
        id: "claim-1",
        path: "organization/group/claim-1",
        scopeKind: "group",
        scopeName: "Platform",
        title: "group knowledge",
        snippet: "Shared guidance",
        score: 1,
        updatedAt: 1,
        content: "# Shared guidance",
        fromLine: 1,
        lineCount: 1,
      };
    });
    const element = createGraph(request);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.memory.graph", { kind: "part" }),
    );
    expect(
      element.querySelector('[data-organization-node="organization/part/claim-1"]'),
    ).not.toBeNull();

    element
      .querySelector("#organization-memory-graph-kind-tab-group")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.memory.graph", { kind: "group" }),
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
    expect(element.querySelector("[data-memory-verification]")?.textContent).toContain("3");
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
    const svg = element.querySelector("svg")!;
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
