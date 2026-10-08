/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeVaultSnapshot } from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import "./memory-vault-graph.ts";

type Selected = NonNullable<KnowledgeVaultSnapshot["selected"]>;
type Element = HTMLElement & {
  selected: Selected;
  busy: boolean;
  updateComplete: Promise<unknown>;
};
function fixture(): Selected {
  const ready = {
    status: "ready" as const,
    indexedRevision: 1,
    error: null,
    attempts: 1,
    retryAt: null,
  };
  return {
    vault: {
      id: "v",
      name: "Spec",
      type: "shared",
      description: "",
      role: "reader",
      canRead: true,
      canEdit: false,
      canManageMembers: false,
      canExport: false,
      createdAt: 1,
      updatedAt: 1,
    },
    documents: ["Alpha", "Beta", "Orphan"].map((title) => ({
      id: title,
      vaultId: "v",
      title,
      logicalPath: `${title}.md`,
      revision: 1,
      updatedAt: 1,
      compile: ready,
    })),
    members: [],
    grants: [],
    attachments: [],
    graph: {
      edges: [
        { source: "Alpha", target: "Beta" },
        { source: "Beta", target: "Alpha" },
      ],
      unresolvedLinks: 1,
      truncated: false,
    },
  };
}
async function mount(selected = fixture()) {
  const element = document.createElement("platformclaw-vault-documents") as Element;
  element.selected = selected;
  document.body.append(element);
  await element.updateComplete;
  element
    .querySelector("#vault-documents-tab-graph")!
    .dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
  await element.updateComplete;
  return element;
}
beforeEach(async () => {
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});
afterEach(() => document.body.replaceChildren());

describe("Memory Hub Shared document graph", () => {
  it("highlights only direct neighbors, restores click selection after hover, and expands their titles", async () => {
    const selected = fixture();
    const fullTitle = "다음 담당자에게 넘길 작업의 맥락과 검증 근거를 보존하는 긴 제목 문서";
    selected.documents[1]!.title = fullTitle;
    const element = await mount(selected);
    const node = (id: string) =>
      element.querySelector<SVGGElement>(`[data-svg-graph-node="${id}"]`)!;
    const state = (id: string) => node(id).dataset.svgGraphState;
    const label = () => node("Beta").querySelector("text")!;
    expect([state("Alpha"), state("Beta"), state("Orphan")]).toEqual(["idle", "idle", "idle"]);
    expect(node("Alpha").querySelector("circle")!.getAttribute("r")).toBe("4");
    expect(label().textContent).toContain("…");
    node("Alpha").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await element.updateComplete;
    expect([state("Alpha"), state("Beta"), state("Orphan")]).toEqual([
      "active",
      "neighbor",
      "muted",
    ]);
    expect(label().textContent).toBe(fullTitle);
    expect(label().querySelectorAll("tspan").length).toBeGreaterThan(1);
    expect(
      [...element.querySelectorAll<SVGLineElement>("line")].map(
        (edge) => edge.dataset.svgGraphState,
      ),
    ).toEqual(["active", "active"]);
    node("Orphan").dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect([state("Alpha"), state("Beta"), state("Orphan")]).toEqual(["muted", "muted", "active"]);
    node("Orphan").dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    expect([state("Alpha"), state("Beta"), state("Orphan")]).toEqual([
      "active",
      "neighbor",
      "muted",
    ]);
    node("Beta").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(state("Beta")).toBe("active");
    node("Beta").dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(state("Alpha")).toBe("active");
    const picker = element.querySelector<HTMLSelectElement>("select")!;
    picker.value = "";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    const controls = element.querySelectorAll<HTMLButtonElement>(".svg-graph-controls button");
    controls[0]!.click();
    controls[0]!.click();
    expect(label().textContent).toBe(fullTitle);
    controls[2]!.click();
    expect(label().textContent).toContain("…");
  });

  it("shows directed reciprocal edges, searchable orphan documents and explicit document navigation", async () => {
    const element = await mount();
    const opened = vi.fn();
    element.addEventListener("vault-document-open", opened);
    expect(element.querySelectorAll("[data-svg-graph-node]")).toHaveLength(3);
    const lines = [...element.querySelectorAll("line")];
    expect(
      lines.map((line) => [
        line.getAttribute("data-svg-graph-source"),
        line.getAttribute("data-svg-graph-target"),
      ]),
    ).toEqual([
      ["Alpha", "Beta"],
      ["Beta", "Alpha"],
    ]);
    expect(
      lines.every(
        (line) =>
          line.getAttribute("marker-end") === "url(#vault-graph-arrow)" &&
          line.getAttribute("data-svg-graph-offset") === "5",
      ),
    ).toBe(true);
    element
      .querySelector('[data-svg-graph-node="Alpha"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector(".vault-graph__inspector")!.textContent).toContain("Backlinks");
    expect(element.querySelectorAll(".vault-graph__inspector section button")).toHaveLength(2);
    expect(opened).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>(".vault-graph__inspector > button")!.click();
    expect(opened.mock.calls[0]![0].detail).toBe("Alpha");
    const input = element.querySelector<HTMLInputElement>("input[type=search]")!;
    input.value = "Orphan.md";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-svg-graph-node]")).toHaveLength(1);
    expect(element.querySelectorAll("line")).toHaveLength(0);
    expect(element.querySelector(".vault-graph__inspector h3")).toBeNull();
    const picker = element.querySelector<HTMLSelectElement>("select")!;
    picker.value = "Orphan";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector(".vault-graph__inspector h3")!.textContent).toBe("Orphan");
    expect(element.textContent).toContain("No links in this direction.");
    element.busy = true;
    await element.updateComplete;
    expect(
      element.querySelector<HTMLButtonElement>(".vault-graph__inspector > button")!.disabled,
    ).toBe(true);
  });

  it("preserves graph mode across refreshed revisions and distinguishes a failed first index from retained links", async () => {
    const element = await mount();
    element.querySelector('[data-svg-graph-node="Alpha"]')!.dispatchEvent(new MouseEvent("click"));
    await element.updateComplete;
    const updated = fixture();
    updated.documents[0] = {
      ...updated.documents[0]!,
      logicalPath: "moved/alpha.md",
      revision: 3,
      compile: {
        status: "failed",
        indexedRevision: 1,
        error: "Parser failed",
        attempts: 2,
        retryAt: 1000,
      },
    };
    element.selected = updated;
    await element.updateComplete;
    const inspector = () => element.querySelector(".vault-graph__inspector")!;
    expect(inspector().textContent).toContain("moved/alpha.md · r3");
    expect(inspector().textContent).toContain(
      "The last successful search data and links remain available",
    );
    expect(inspector().textContent).toContain("Next retry");
    expect(inspector().textContent).toContain("Parser failed");
    const missingIndex = structuredClone(updated);
    missingIndex.documents[0]!.compile.indexedRevision = null;
    element.selected = missingIndex;
    await element.updateComplete;
    expect(inspector().textContent).toContain("No search data or links have been generated yet");
    expect(inspector().textContent).not.toContain("The last successful search data");
  });

  it("draws a self-reference as a visible loop that travels with its document node", async () => {
    const selected = fixture();
    selected.graph.edges.push({ source: "Alpha", target: "Alpha" });
    const element = await mount(selected);
    const loop = element.querySelector('[data-vault-self-link="Alpha"]');
    expect(loop?.tagName).toBe("path");
    expect(loop?.closest("[data-svg-graph-node]")?.getAttribute("data-svg-graph-node")).toBe(
      "Alpha",
    );
    expect(loop?.getAttribute("marker-end")).toBe("url(#vault-graph-arrow)");
    expect(element.querySelectorAll("line")).toHaveLength(2);
  });

  it("reports empty and truncated graphs without claiming omitted links do not exist", async () => {
    const empty = await mount({
      ...fixture(),
      documents: [],
      graph: { edges: [], unresolvedLinks: 0, truncated: false },
    });
    expect(empty.textContent).toContain("No documents yet");
    empty.remove();
    const truncated = await mount({
      ...fixture(),
      graph: { edges: [], unresolvedLinks: 2, truncated: true },
    });
    truncated
      .querySelector('[data-svg-graph-node="Orphan"]')!
      .dispatchEvent(new MouseEvent("click"));
    await truncated.updateComplete;
    expect(truncated.textContent).toContain("Some documents or links are omitted");
    expect(truncated.textContent).toContain("2 unresolved links");
    expect(truncated.textContent).toContain("Some links may be omitted");
  });
  it("keeps an expanded document catalog separate from bounded graph nodes and exposes its search scope", async () => {
    const selected = fixture();
    selected.documentCount = 7;
    selected.documentsTruncated = true;
    selected.graph.nodeIds = ["Alpha", "Beta", "concepts/index.md"];
    selected.graph.truncated = true;
    selected.graph.edges.push({ source: "concepts/index.md", target: "Alpha" });
    const element = await mount(selected);
    expect(element.querySelectorAll("[data-svg-graph-node]")).toHaveLength(2);
    expect(element.querySelector('[data-svg-graph-node="Orphan"]')).toBeNull();
    expect(element.querySelectorAll("line")).toHaveLength(2);
    expect(element.textContent).toContain("filter covers the displayed documents");
    element
      .querySelector('[data-svg-graph-node="Alpha"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll(".vault-graph__inspector section button")).toHaveLength(2);
    const documentsTab = element.querySelector<HTMLElement>("#vault-documents-tab-documents");
    expect(documentsTab).not.toBeNull();
    documentsTab!.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await element.updateComplete;
    expect(documentsTab!.getAttribute("aria-selected")).toBe("true");
    const notice = element.querySelector("[data-vault-documents-truncated]");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("Showing 3 of 7 documents");
    expect(element.textContent).toContain("Search document contents above");
    expect(element.querySelectorAll(".settings-row")).toHaveLength(3);
    const opened = vi.fn();
    element.addEventListener("vault-document-open", opened);
    const orphan = [...element.querySelectorAll<HTMLButtonElement>(".settings-row")].find(
      (button) => button.textContent?.includes("Orphan"),
    )!;
    orphan.click();
    expect(opened.mock.calls[0]![0].detail).toBe("Orphan");
  });
});
