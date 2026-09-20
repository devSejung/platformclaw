/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { buildDreamingViewProps, type DreamingProps } from "./view.test-helpers.ts";
import {
  createDreamingViewState,
  renderWikiKnowledge,
  wikiDraftDirty,
  wikiDocumentT,
  type DreamingViewState,
} from "./view.ts";
import { wikiDocumentTranslations } from "./wiki-document-translations.ts";

let viewState = createDreamingViewState();

function buildProps(overrides?: Partial<DreamingProps>): DreamingProps {
  return buildDreamingViewProps(viewState, overrides);
}

function setDreamDiarySubTab(tab: DreamingViewState["activeDiarySubTab"]): void {
  viewState.activeDiarySubTab = tab;
}

function expectElement(container: Element, selector: string): Element {
  const element = container.querySelector(selector);
  expect(element).toBeInstanceOf(Element);
  if (!(element instanceof Element)) {
    throw new Error(`Expected element matching ${selector}`);
  }
  return element;
}

function selectWikiDocumentAction(container: Element, value: string): void {
  if (value === "edit") {
    (expectElement(container, "[data-wiki-edit]") as HTMLButtonElement).click();
    return;
  }
  expectElement(container, ".wiki-document__menu").dispatchEvent(
    new CustomEvent("wa-select", { detail: { item: { value } } }),
  );
}

function selectGraphDocumentAndOpen(container: Element, id = "concepts/alpha.md"): void {
  expectElement(container, `[data-wiki-node='${id}']`).dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );
  const open = expectElement(container, ".memory-wiki-graph__open") as HTMLButtonElement;
  open.click();
}

describe("Wiki document preview and editing", () => {
  it("owns document labels without fetching overlays and responds to the active locale", () => {
    const locale = vi.spyOn(i18n, "getLocale");
    try {
      expect(Object.keys(wikiDocumentTranslations.en).toSorted()).toEqual(
        Object.keys(wikiDocumentTranslations.ko).toSorted(),
      );
      for (const selected of ["en", "ko", "fr"] as const) {
        locale.mockReturnValue(selected);
        const labels = wikiDocumentTranslations[selected === "ko" ? "ko" : "en"];
        for (const [key, label] of Object.entries(labels)) {
          const placeholders = [...label.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!);
          const params = Object.fromEntries(placeholders.map((name) => [name, `sample-${name}`]));
          const expected = placeholders.reduce(
            (value, name) => value.replaceAll(`{${name}}`, `sample-${name}`),
            label,
          );
          expect(wikiDocumentT(key, params)).toBe(expected);
        }
      }
    } finally {
      locale.mockRestore();
    }
  });

  beforeEach(() => {
    viewState = createDreamingViewState();
    viewState.activeSubTab = "diary";
    viewState.activeDiarySubTab = "wiki";
  });

  it("renders a safe Preview and saves through explicit Edit Write/Preview mode", async () => {
    setDreamDiarySubTab("wiki");
    viewState.wikiLayout = "graph";
    const revision = "a".repeat(64);
    const onOpenWikiPage = vi.fn().mockResolvedValue({
      title: "Alpha",
      path: "concepts/alpha.md",
      content: "# Alpha",
      displayContent:
        "# Alpha\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>window.pwned = true</script>",
      sourceContent: "# Alpha",
      editMode: "body",
      editableContent: "# Alpha",
      revision,
    });
    const onSaveWikiPage = vi.fn().mockResolvedValue({
      title: "Alpha",
      path: "concepts/alpha.md",
      content: "# Alpha\n\nSaved **body**",
      displayContent: "# Alpha\n\nSaved **body**",
      sourceContent: "# Alpha\n\nSaved **body**",
      editMode: "body",
      editableContent: "# Alpha\n\nSaved **body**",
      revision: "b".repeat(64),
    });
    const container = document.createElement("div");
    const rerender = () => render(renderWikiKnowledge(props), container);
    const props = buildProps({ onOpenWikiPage, onSaveWikiPage, onViewStateChange: rerender });
    rerender();
    selectGraphDocumentAndOpen(container);
    await vi.waitFor(() =>
      expect(container.querySelector(".wiki-document__reader h1")).not.toBeNull(),
    );
    expect(container.querySelector(".wiki-document__reader table")).not.toBeNull();
    expect(container.querySelector(".wiki-document__reader script")).toBeNull();

    selectWikiDocumentAction(container, "source");
    expect(container.querySelector(".dreams-diary__preview-pre")?.textContent).toBe("# Alpha");
    expect(container.querySelector(".wiki-document__editor")).toBeNull();
    [...container.querySelectorAll<HTMLButtonElement>(".dreams-diary__preview-body button")]
      .find((button) => button.textContent?.trim() === "Back to preview")
      ?.click();

    selectWikiDocumentAction(container, "edit");
    const textarea = container.querySelector<HTMLTextAreaElement>(".wiki-document__editor");
    expect(textarea).not.toBeNull();
    textarea!.value = "# Alpha\n\nSaved **body**";
    textarea!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    [...container.querySelectorAll<HTMLElement>("wa-tab")]
      .find((tab) => tab.textContent?.trim() === "Preview")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(container.querySelector(".wiki-document__reader strong")?.textContent).toBe("body");
    [...container.querySelectorAll<HTMLButtonElement>(".wiki-document__footer button")]
      .find((button) => button.textContent?.trim() === "Save")
      ?.click();
    await vi.waitFor(() => expect(onSaveWikiPage).toHaveBeenCalledOnce());
    expect(onSaveWikiPage).toHaveBeenCalledWith({
      path: "concepts/alpha.md",
      editMode: "body",
      content: "# Alpha\n\nSaved **body**",
      expectedRevision: revision,
    });
    expect(container.querySelector(".wiki-document__editor")).toBeNull();
    expect(container.querySelector(".wiki-document__reader strong")?.textContent).toBe("body");
  });

  it("keeps a dirty draft after a save conflict and honors Cancel confirmation", async () => {
    setDreamDiarySubTab("wiki");
    viewState.wikiLayout = "graph";
    const onOpenWikiPage = vi.fn().mockResolvedValue({
      title: "Alpha",
      path: "concepts/alpha.md",
      content: "Old",
      displayContent: "Old",
      sourceContent: "Old",
      editMode: "body",
      editableContent: "Old",
      revision: "a".repeat(64),
    });
    const onSaveWikiPage = vi.fn().mockRejectedValue(new Error("Wiki document changed"));
    const onConfirmWikiDiscard = vi.fn().mockResolvedValue(false);
    const container = document.createElement("div");
    const rerender = () => render(renderWikiKnowledge(props), container);
    const props = buildProps({
      onOpenWikiPage,
      onSaveWikiPage,
      onConfirmWikiDiscard,
      onViewStateChange: rerender,
    });
    rerender();
    selectGraphDocumentAndOpen(container);
    await vi.waitFor(() =>
      expect(container.querySelector(".wiki-document__menu button")).not.toBeNull(),
    );
    selectWikiDocumentAction(container, "edit");
    let textarea = container.querySelector<HTMLTextAreaElement>(".wiki-document__editor")!;
    textarea.value = "Unsaved draft";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    [...container.querySelectorAll<HTMLButtonElement>(".wiki-document__footer button")]
      .find((button) => button.textContent?.trim() === "Save")
      ?.click();
    await vi.waitFor(() => expect(container.textContent).toContain("Wiki document changed"));
    textarea = container.querySelector<HTMLTextAreaElement>(".wiki-document__editor")!;
    expect(textarea.value).toBe("Unsaved draft");
    [...container.querySelectorAll<HTMLButtonElement>(".wiki-document__footer button")]
      .find((button) => button.textContent?.trim() === "Cancel")
      ?.click();
    await vi.waitFor(() => expect(onConfirmWikiDiscard).toHaveBeenCalledOnce());
    expect(container.querySelector<HTMLTextAreaElement>(".wiki-document__editor")?.value).toBe(
      "Unsaved draft",
    );
  });

  it("keeps source-mode drafts dirty and confirms before closing", async () => {
    setDreamDiarySubTab("wiki");
    viewState.wikiLayout = "graph";
    const onConfirmWikiDiscard = vi.fn().mockResolvedValue(false);
    const container = document.createElement("div");
    const rerender = () => render(renderWikiKnowledge(props), container);
    const props = buildProps({
      onOpenWikiPage: vi.fn().mockResolvedValue({
        title: "Alpha",
        path: "concepts/alpha.md",
        displayContent: "Old",
        sourceContent: "Old",
        editMode: "body",
        editableContent: "Old",
        revision: "a".repeat(64),
      }),
      onConfirmWikiDiscard,
      onViewStateChange: rerender,
    });
    rerender();
    selectGraphDocumentAndOpen(container);
    await vi.waitFor(() => expect(container.querySelector(".wiki-document__menu")).not.toBeNull());
    selectWikiDocumentAction(container, "edit");
    const textarea = expectElement(container, ".wiki-document__editor") as HTMLTextAreaElement;
    textarea.value = "Unsaved draft";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    selectWikiDocumentAction(container, "source");
    expect(wikiDraftDirty(viewState)).toBe(true);
    const modal = expectElement(container, "openclaw-modal-dialog");
    modal.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true }));
    await vi.waitFor(() => expect(onConfirmWikiDiscard).toHaveBeenCalledOnce());
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();
  });

  it("resolves rendered relative Wiki links from the current document", async () => {
    setDreamDiarySubTab("wiki");
    viewState.wikiLayout = "graph";
    const onOpenWikiPage = vi.fn().mockResolvedValue({
      title: "Report",
      path: "reports/status.md",
      displayContent: "[Related](../concepts/related.md)",
      sourceContent: "[Related](../concepts/related.md)",
      editMode: null,
    });
    const container = document.createElement("div");
    const rerender = () => render(renderWikiKnowledge(props), container);
    const props = buildProps({ onOpenWikiPage, onViewStateChange: rerender });
    rerender();
    selectGraphDocumentAndOpen(container);
    await vi.waitFor(() =>
      expect(container.querySelector(".wiki-document__reader a")).not.toBeNull(),
    );
    container
      .querySelector(".wiki-document__reader a")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(onOpenWikiPage).toHaveBeenLastCalledWith("concepts/related.md"));
  });
});
