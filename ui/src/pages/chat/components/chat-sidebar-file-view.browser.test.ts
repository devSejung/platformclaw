import { EditorView } from "@codemirror/view";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../../i18n/lib/translate.test-support.ts";
import "../../../styles.css";
import "./chat-sidebar.ts";

// The root jsdom ui shard also collects *.browser.test.ts files; CodeMirror
// needs a real DOM, so this suite only runs in the checks-ui Chromium project.
// Importing vitest/browser statically would throw during jsdom collection.
const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
const restoreLocale = captureI18nStateForTesting();

type FileSidebarContent = {
  kind: "file";
  path: string;
  name: string;
  content: string;
  draftKey?: string;
  language?: string;
  line?: number | null;
  edit?: {
    hash: string;
    save: (params: {
      content: string;
      expectedHash: string;
    }) => Promise<
      | { ok: true; hash: string }
      | { ok: false; code: "conflict"; latest: { content: string; hash: string } }
      | { ok: false; code: "error"; message: string }
    >;
    fetchLatest: () => Promise<{ content: string; hash: string; editable: boolean } | null>;
  };
};

beforeAll(async () => {
  if (browserMode) {
    // Button assertions use English; the browser may inherit a different host locale.
    await i18n.setLocale("en");
    ({ userEvent } = await import("vitest/browser"));
  }
});

afterAll(restoreLocale);

type DetailPanel = HTMLElement & {
  content: FileSidebarContent;
  updateComplete: Promise<unknown>;
};

const mounted: DetailPanel[] = [];

async function mountFile(content: FileSidebarContent): Promise<DetailPanel> {
  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.content = content;
  document.body.append(panel);
  mounted.push(panel);
  await panel.updateComplete;
  await expect.poll(() => panel.querySelector(".cm-editor"), { timeout: 5_000 }).not.toBeNull();
  return panel;
}

function button(panel: DetailPanel, label: string): HTMLButtonElement {
  const match = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  if (!match) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

afterEach(() => {
  for (const panel of mounted.splice(0)) {
    panel.remove();
  }
});

describe.runIf(browserMode)("chat file editor", () => {
  it("keeps the editor idle during unrelated panel updates while preserving edits", async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-2" });
    const panel = await mountFile({
      kind: "file",
      path: "idle-editor.txt",
      name: "idle-editor.txt",
      content: "first\nsecond\nthird",
      line: 2,
      edit: { hash: "hash-1", save, fetchLatest: vi.fn() },
    });
    await userEvent.click(button(panel, "Edit file"));
    const editor = panel.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.fill(editor, "draft\nsecond\nthird");
    const draft = editor.textContent;
    const updates = vi.spyOn(EditorView.prototype, "update");
    try {
      for (let index = 0; index < 10; index += 1) {
        Object.assign(panel, { allowExternalEmbedUrls: index % 2 === 0 });
        await panel.updateComplete;
        await Promise.resolve();
      }
      expect(updates).not.toHaveBeenCalled();
      expect(panel.querySelector(".cm-content")).toBe(editor);
      expect(document.activeElement).toBe(editor);
      expect(editor.textContent).toBe(draft);

      await userEvent.click(button(panel, "Discard"));
      expect(editor.getAttribute("contenteditable")).toBe("false");

      // Equal line inputs must be reapplied after replacing the document's positions.
      panel.content.content = "a longer first line\nsecond\nthird";
      Object.assign(panel, { allowExternalEmbedUrls: true });
      await panel.updateComplete;
      await expect
        .poll(() => [...editor.querySelectorAll(".cm-line")].map((line) => line.textContent))
        .toEqual(["a longer first line", "second", "third"]);
      const target = editor.querySelector(".file-view__line--target");
      expect(target?.textContent).toBe("second");
      expect(target?.getAttribute("data-line")).toBe("2");
      expect(panel.querySelector(".cm-content")).toBe(editor);

      await userEvent.click(button(panel, "Edit file"));
      await userEvent.fill(editor, "saved after idle\nsecond\nthird");
      await userEvent.click(button(panel, "Save"));
      await expect.poll(() => save.mock.calls.length).toBe(1);
      expect(save).toHaveBeenCalledWith({
        content: "saved after idle\nsecond\nthird",
        expectedHash: "hash-1",
      });
      await expect.poll(() => button(panel, "Save").disabled).toBe(true);
      expect(editor.getAttribute("contenteditable")).toBe("true");
    } finally {
      updates.mockRestore();
    }
  });

  it("renders content and decorates the requested line", async () => {
    const panel = await mountFile({
      kind: "file",
      path: "src/example.ts",
      name: "example.ts",
      content: "const first = 1;\nconst second = 2;",
      line: 2,
    });

    expect(panel.querySelector(".cm-content")?.textContent).toContain("const second = 2;");
    const target = panel.querySelector(".file-view__line--target");
    expect(target?.getAttribute("data-line")).toBe("2");
  });

  it("refreshes search matches and the current match without replacing the editor", async () => {
    const panel = await mountFile({
      kind: "file",
      path: "search.txt",
      name: "search.txt",
      content: "alpha\nbeta\nalpha beta",
      line: 2,
    });
    const editor = panel.querySelector(".cm-content");
    await userEvent.click(button(panel, "Search in file"));
    const search = panel.querySelector<HTMLInputElement>(".file-view__search input")!;
    await userEvent.fill(search, "alpha");
    await expect
      .poll(() =>
        [...panel.querySelectorAll(".file-view__line--match")].map((line) => line.textContent),
      )
      .toEqual(["alpha", "alpha beta"]);
    await userEvent.click(button(panel, "Next match"));
    await expect
      .poll(() => panel.querySelector(".file-view__line--current")?.textContent)
      .toBe("alpha beta");
    await userEvent.fill(search, "beta");
    await expect
      .poll(() =>
        [...panel.querySelectorAll(".file-view__line--match")].map((line) => line.textContent),
      )
      .toEqual(["beta", "alpha beta"]);
    expect(panel.querySelector(".file-view__line--current")?.textContent).toBe("beta");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => panel.querySelectorAll(".file-view__line--match").length).toBe(0);
    expect(panel.querySelector(".file-view__line--current")).toBeNull();
    expect(panel.querySelector(".file-view__line--target")?.textContent).toBe("beta");
    expect(panel.querySelector(".cm-content")).toBe(editor);
  });

  it("enables save after an edit and keeps the saved content", async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-2" });
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest: vi.fn() },
    });

    await userEvent.click(button(panel, "Edit file"));
    const editor = panel.querySelector<HTMLElement>(".cm-content");
    expect(editor).not.toBeNull();
    await userEvent.fill(editor!, "after");
    const saveButton = button(panel, "Save");
    expect(saveButton.disabled).toBe(false);
    await userEvent.click(saveButton);

    await expect.poll(() => save.mock.calls.length).toBe(1);
    expect(save).toHaveBeenCalledWith({ content: "after", expectedHash: "hash-1" });
    await expect.poll(() => button(panel, "Save").disabled).toBe(true);
    expect(panel.querySelector(".cm-content")?.textContent).toContain("after");
  });

  it("round-trips CRLF line endings through an edit and save", async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-2" });
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "alpha\r\nbeta",
      edit: { hash: "hash-1", save, fetchLatest: vi.fn() },
    });

    await userEvent.click(button(panel, "Edit file"));
    const editor = panel.querySelector<HTMLElement>(".cm-content");
    expect(editor).not.toBeNull();
    await userEvent.type(editor!, "x");
    await userEvent.click(button(panel, "Save"));

    await expect.poll(() => save.mock.calls.length).toBe(1);
    const saved = expectDefined(save.mock.calls[0], "save callback call")[0] as {
      content: string;
    };
    expect(saved.content).toContain("\r\n");
    expect(saved.content).toContain("x");
  });

  it("keeps edits made while a save is in flight dirty", async () => {
    let finishSave: ((outcome: { ok: true; hash: string }) => void) | undefined;
    const save = vi.fn().mockImplementation(
      () =>
        new Promise<{ ok: true; hash: string }>((resolve) => {
          finishSave = resolve;
        }),
    );
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest: vi.fn() },
    });

    await userEvent.click(button(panel, "Edit file"));
    const editor = panel.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.fill(editor, "submitted");
    await userEvent.click(button(panel, "Save"));
    await userEvent.fill(editor, "newer");
    finishSave?.({ ok: true, hash: "hash-2" });

    await expect.poll(() => button(panel, "Save").textContent?.trim()).toBe("Save");
    expect(button(panel, "Save").disabled).toBe(false);
    expect(editor.textContent).toContain("newer");
    await userEvent.click(button(panel, "Discard"));
  });

  it("restores an unsaved draft after the detail panel is closed", async () => {
    const originalEdit = { hash: "hash-1", save: vi.fn(), fetchLatest: vi.fn() };
    const first = await mountFile({
      kind: "file",
      draftKey: "session-a\u0000notes.txt",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: originalEdit,
    });

    await userEvent.click(button(first, "Edit file"));
    await userEvent.fill(first.querySelector<HTMLElement>(".cm-content")!, "unsaved draft");
    first.remove();

    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-3" });
    const reopened = await mountFile({
      kind: "file",
      draftKey: "session-a\u0000notes.txt",
      path: "notes.txt",
      name: "notes.txt",
      content: "latest",
      edit: { hash: "hash-2", save, fetchLatest: vi.fn() },
    });
    await expect
      .poll(() => reopened.querySelector(".cm-content")?.textContent)
      .toContain("unsaved");
    expect(reopened.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    expect(button(reopened, "Save").disabled).toBe(false);

    await userEvent.click(button(reopened, "Discard"));
    await userEvent.click(button(reopened, "Edit file"));
    await userEvent.fill(reopened.querySelector<HTMLElement>(".cm-content")!, "new edit");
    await userEvent.click(button(reopened, "Save"));
    await expect.poll(() => save.mock.calls.length).toBe(1);
    expect(save).toHaveBeenCalledWith({ content: "new edit", expectedHash: "hash-2" });
  });

  it("scopes retained drafts to the session file identity", async () => {
    const edit = { hash: "hash-1", save: vi.fn(), fetchLatest: vi.fn() };
    const first = await mountFile({
      kind: "file",
      draftKey: "gateway-a\u0000pane-left\u0000session-a\u0000shared.txt",
      path: "shared.txt",
      name: "shared.txt",
      content: "session a",
      edit,
    });

    await userEvent.click(button(first, "Edit file"));
    await userEvent.fill(first.querySelector<HTMLElement>(".cm-content")!, "session a draft");
    first.remove();

    const otherSession = await mountFile({
      kind: "file",
      draftKey: "gateway-a\u0000pane-right\u0000session-a\u0000shared.txt",
      path: "shared.txt",
      name: "shared.txt",
      content: "session b",
      edit,
    });
    expect(otherSession.querySelector(".cm-content")?.textContent).toContain("session b");
    expect(otherSession.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe(
      "false",
    );

    const restored = await mountFile({
      kind: "file",
      draftKey: "gateway-a\u0000pane-left\u0000session-a\u0000shared.txt",
      path: "shared.txt",
      name: "shared.txt",
      content: "session a",
      edit,
    });
    await expect.poll(() => restored.querySelector(".cm-content")?.textContent).toContain("draft");
    await userEvent.click(button(restored, "Discard"));
  });

  it("reloads the latest content after a save conflict", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, code: "conflict" });
    const fetchLatest = vi
      .fn()
      .mockResolvedValue({ content: "latest", hash: "hash-2", editable: true });
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest },
    });

    await userEvent.click(button(panel, "Edit file"));
    await userEvent.fill(panel.querySelector<HTMLElement>(".cm-content")!, "local");
    await userEvent.click(button(panel, "Save"));
    await expect
      .poll(() => panel.querySelector('[role="alert"]')?.textContent)
      .toContain("File changed on disk since it was loaded.");

    await userEvent.click(button(panel, "Reload"));
    await expect.poll(() => panel.querySelector(".cm-content")?.textContent).toContain("latest");
    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(button(panel, "Save").disabled).toBe(true);
  });

  it("drops edit mode when a conflict reload returns non-editable content", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, code: "conflict" });
    const fetchLatest = vi.fn().mockResolvedValue({
      content: "mixed\r\nendings\nnow",
      hash: "hash-2",
      editable: false,
    });
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest },
    });

    await userEvent.click(button(panel, "Edit file"));
    await userEvent.fill(panel.querySelector<HTMLElement>(".cm-content")!, "local");
    await userEvent.click(button(panel, "Save"));
    await expect.poll(() => panel.querySelector('[role="alert"]')).not.toBeNull();
    await userEvent.click(button(panel, "Reload"));

    await expect.poll(() => panel.querySelector(".cm-content")?.textContent).toContain("mixed");
    expect(panel.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
    expect(
      Array.from(panel.querySelectorAll("button")).some(
        (candidate) => candidate.getAttribute("aria-label") === "Edit file",
      ),
    ).toBe(false);
  });

  it("makes the editor read-only while reloading a conflict", async () => {
    let finishReload:
      | ((latest: { content: string; hash: string; editable: boolean }) => void)
      | undefined;
    const save = vi.fn().mockResolvedValue({ ok: false, code: "conflict" });
    const fetchLatest = vi.fn().mockImplementation(
      () =>
        new Promise<{ content: string; hash: string; editable: boolean }>((resolve) => {
          finishReload = resolve;
        }),
    );
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest },
    });

    await userEvent.click(button(panel, "Edit file"));
    await userEvent.fill(panel.querySelector<HTMLElement>(".cm-content")!, "local");
    await userEvent.click(button(panel, "Save"));
    await expect
      .poll(() => panel.querySelector('[role="alert"]')?.textContent)
      .toContain("File changed on disk since it was loaded.");
    await userEvent.click(button(panel, "Reload"));

    await expect
      .poll(() => panel.querySelector(".cm-content")?.getAttribute("contenteditable"))
      .toBe("false");
    finishReload?.({ content: "latest", hash: "hash-2", editable: true });
    await expect.poll(() => panel.querySelector(".cm-content")?.textContent).toContain("latest");
    expect(panel.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
  });
});
