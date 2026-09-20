/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDreamingViewProps, type DreamingProps } from "./view.test-helpers.ts";
import { createDreamingViewState, renderWikiKnowledge } from "./view.ts";

let viewState = createDreamingViewState();

function buildProps(overrides?: Partial<DreamingProps>): DreamingProps {
  return buildDreamingViewProps(viewState, overrides);
}

function expectElement(container: Element, selector: string): Element {
  const element = container.querySelector(selector);
  expect(element).toBeInstanceOf(Element);
  if (!(element instanceof Element)) {
    throw new Error(`Expected element matching ${selector}`);
  }
  return element;
}

function compactText(node: Element | null): string | undefined {
  return node?.textContent?.trim().replace(/\s+/g, " ");
}

describe("Personal Wiki graph", () => {
  beforeEach(() => {
    viewState = createDreamingViewState();
    viewState.activeDiarySubTab = "wiki";
  });

  it("selects graph nodes without fetching and explicitly opens the selected document", async () => {
    const onSelectWikiGraph = vi.fn();
    const onOpenWikiPage = vi.fn(async (lookup: string) => ({
      title: lookup === "concepts/alpha.md" ? "Alpha" : lookup,
      path: lookup,
      content: "# Alpha\n\nGraph preview content.",
      totalLines: 3,
      truncated: false,
    }));
    const container = document.createElement("div");
    const rerender = () => render(renderWikiKnowledge(props), container);
    const props = buildProps({ onSelectWikiGraph, onOpenWikiPage, onViewStateChange: rerender });
    rerender();

    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>(".memory-wiki-view-switch button"),
    ];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Cards", "Graph"]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".memory-wiki-graph")).toBeNull();

    buttons[1]?.click();
    expect(onSelectWikiGraph).toHaveBeenCalledOnce();
    expect(viewState.wikiLayout).toBe("graph");
    const edge = expectElement(container, ".memory-wiki-graph__edges line");
    expect(edge.namespaceURI).toBe("http://www.w3.org/2000/svg");
    const node = expectElement(container, "[data-wiki-node='concepts/alpha.md']");
    expect(node.namespaceURI).toBe("http://www.w3.org/2000/svg");
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenWikiPage).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-wiki-node='concepts/alpha.md']")?.getAttribute("aria-pressed"),
    ).toBe("true");
    let inspector = expectElement(container, ".memory-wiki-graph__inspector");
    expect(compactText(inspector.querySelector(".settings-row__title"))).toBe("Alpha");
    expect(
      compactText(inspector.querySelector<HTMLButtonElement>("button.settings-row--nav")),
    ).toContain("Travel system");

    const neighbor = expectElement(container, "[data-wiki-node='syntheses/travel-system.md']");
    neighbor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onOpenWikiPage).not.toHaveBeenCalled();
    expect(
      container
        .querySelector("[data-wiki-node='syntheses/travel-system.md']")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    inspector = expectElement(container, ".memory-wiki-graph__inspector");
    expect(compactText(inspector.querySelector(".settings-row__title"))).toBe("Travel system");

    const open = container.querySelector<HTMLButtonElement>(".memory-wiki-graph__open");
    expect(open).toBeInstanceOf(HTMLButtonElement);
    open?.click();
    await vi.waitFor(() => {
      expect(onOpenWikiPage).toHaveBeenCalledWith("syntheses/travel-system.md");
      expect(container.querySelector(".wiki-document__reader")?.textContent).toContain(
        "Graph preview content.",
      );
    });
  });

  it("selects a visible graph node from the accessible document picker", () => {
    viewState.wikiLayout = "graph";
    const onOpenWikiPage = vi.fn();
    const container = document.createElement("div");
    const rerender = () => render(renderWikiKnowledge(props), container);
    const props = buildProps({ onOpenWikiPage, onViewStateChange: rerender });
    rerender();

    const picker = container.querySelector<HTMLSelectElement>(".memory-wiki-graph__picker select");
    expect(picker).toBeInstanceOf(HTMLSelectElement);
    expect(compactText(picker!.closest("label")?.querySelector("span") ?? null)).toBe(
      "Select a document",
    );
    picker!.value = "syntheses/travel-system.md";
    picker!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onOpenWikiPage).not.toHaveBeenCalled();
    expect(
      container
        .querySelector("[data-wiki-node='syntheses/travel-system.md']")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("filters the Personal Wiki graph by safe top-level directory and clears a hidden selection", () => {
    viewState.wikiLayout = "graph";
    const container = document.createElement("div");
    const rerender = () => render(renderWikiKnowledge(props), container);
    const props = buildProps({
      onViewStateChange: rerender,
      wikiGraph: {
        nodes: [
          { id: "home.md", title: "Home", kind: "concept" },
          { id: "raw/source.md", title: "Source", kind: "source" },
          { id: "syntheses/summary.md", title: "Summary", kind: "synthesis" },
        ],
        edges: [
          { source: "home.md", target: "raw/source.md", type: "reference" },
          { source: "raw/source.md", target: "syntheses/summary.md", type: "reference" },
        ],
        stats: {
          totalPages: 3,
          totalNodes: 3,
          totalEdges: 2,
          unresolvedLinks: 1,
          truncated: false,
        },
      },
    });
    rerender();

    expect(container.textContent).toContain("Root");
    expectElement(container, '[data-wiki-node="raw/source.md"]').dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(container.querySelector(".memory-wiki-graph__open")).not.toBeNull();
    const raw = [...container.querySelectorAll("label")].find((label) =>
      label.textContent?.includes("raw"),
    )!;
    const input = raw.querySelector("input") as HTMLInputElement;
    input.checked = false;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(container.querySelector('[data-wiki-node="raw/source.md"]')).toBeNull();
    expect(container.querySelectorAll(".memory-wiki-graph__edges line")).toHaveLength(0);
    expect(container.textContent).toContain("2 nodes");
    expect(container.textContent).toContain("0 links");
    expect(container.textContent).not.toContain("unresolved");
    expect(container.querySelector(".memory-wiki-graph__open")).toBeNull();
  });

  it.each([
    {
      name: "empty",
      overrides: {
        wikiGraph: {
          nodes: [],
          edges: [],
          stats: {
            totalPages: 0,
            totalNodes: 0,
            totalEdges: 0,
            unresolvedLinks: 0,
            truncated: false,
          },
        },
      },
      expected: "No linked wiki pages yet",
    },
    {
      name: "error",
      overrides: { wikiGraph: null, wikiGraphError: "gateway unavailable" },
      expected: "Could not load the wiki graph",
    },
  ])("renders the graph $name state", ({ overrides, expected }) => {
    viewState.wikiLayout = "graph";
    const container = document.createElement("div");
    render(renderWikiKnowledge(buildProps(overrides)), container);
    expect(container.textContent).toContain(expected);
  });
});
