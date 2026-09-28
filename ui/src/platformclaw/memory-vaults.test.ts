/* @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  KnowledgeVaultDocument,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import {
  wikiHubSnapshot,
  wikiHubPersonalId,
  wikiHubPersonalDocument,
} from "../test-helpers/platformclaw-wiki-hub-fixture.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  button,
  document,
  fill,
  mount,
  rpc,
  setupVaultTests,
  snapshot,
  submit,
} from "./memory-vaults.test-support.ts";

setupVaultTests();

describe("Shared Knowledge Vault UI", () => {
  it("keeps all accessible vaults visible when disabled and discovers unreadable metadata only", async () => {
    let current = wikiHubSnapshot();
    const request = vi.fn(
      async (method: string, params: { vaultId?: string; connected?: boolean }) => {
        if (method === `${rpc}connection.set`) {
          current = {
            ...current,
            vaults: current.vaults.map((vault) =>
              vault.id === params.vaultId ? { ...vault, connected: params.connected! } : vault,
            ),
          };
        }
        return current;
      },
    );
    const element = mount(request);
    await waitForFast(() => expect(element.querySelectorAll("[data-vault-card]")).toHaveLength(3));
    const personal = element.querySelector(`[data-vault-card="${wikiHubPersonalId}"]`)!;
    expect(personal.querySelectorAll("[data-vault-role]")).toHaveLength(1);
    expect(personal.textContent).toContain("Owner");
    const toggle = element.querySelector(
      '[data-vault-card="vault-phy"] wa-switch',
    ) as HTMLElement & { checked: boolean };
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}connection.set`, {
        vaultId: "vault-phy",
        connected: false,
      }),
    );
    expect(element.querySelector('[data-vault-card="vault-phy"]')).not.toBeNull();
    await waitForFast(() => expect(toggle.checked).toBe(false));
    element
      .querySelector("#vault-catalog-tab-discover")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await element.updateComplete;
    const inaccessible = element.querySelector('[data-vault-card="vault-lpddr"]')!;
    expect(inaccessible.textContent).toContain("Access required");
    expect(inaccessible.querySelector("wa-switch")).toBeNull();
    expect(inaccessible.querySelector("[data-vault-role]")).toBeNull();
    expect(inaccessible.textContent).not.toMatch(/\d+ documents/i);
    button(element, "Request access").click();
    await waitForFast(() => expect(element.querySelector('select[name="role"]')).not.toBeNull());
    current = wikiHubSnapshot({ pending: true });
    submit(element.querySelector('select[name="role"]')!.closest("form")!);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}access.request`, {
        vaultId: "vault-lpddr",
        role: "reader",
        reason: "",
      }),
    );
    await waitForFast(() => expect(button(element, "Request pending").disabled).toBe(true));
  });
  it("keeps granted knowledge readable and explains a full AI reference limit", async () => {
    const current = wikiHubSnapshot();
    current.vaults = current.vaults.map((vault) =>
      vault.id === "vault-dram" ? { ...vault, connectionIssue: "capacity" as const } : vault,
    );
    const element = mount(vi.fn().mockResolvedValue(current));
    await waitForFast(() =>
      expect(element.querySelector('[data-vault-card="vault-dram"]')).not.toBeNull(),
    );
    const card = element.querySelector<HTMLElement>('[data-vault-card="vault-dram"]')!;
    expect(card.textContent).toContain("Turn off another vault");
    expect(card.querySelectorAll("[data-vault-role]")).toHaveLength(1);
    expect(button(card, "Open vault").disabled).toBe(false);
    expect((card.querySelector("wa-switch") as HTMLElement & { checked: boolean }).checked).toBe(
      false,
    );
  });
  it("finds the server Personal card by its visible name", async () => {
    const element = mount(vi.fn().mockResolvedValue(wikiHubSnapshot()));
    await waitForFast(() =>
      expect(element.querySelector(`[data-vault-card="${wikiHubPersonalId}"]`)).not.toBeNull(),
    );
    const query = element.querySelector<HTMLInputElement>(".vaults__catalog-search input")!;
    query.value = "Personal";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-vault-card]")).toHaveLength(1);
    expect(element.textContent).not.toContain("No matching vaults");
  });
  it("uses advertised search and author capabilities instead of assuming availability", async () => {
    const request = vi.fn().mockResolvedValue(snapshot());
    const element = mount(request);
    element.methods = [`${rpc}document.get`];
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    expect(
      [...element.querySelectorAll("button")].some(
        (item) => item.textContent?.trim() === "Add knowledge",
      ),
    ).toBe(false);
    expect(element.querySelector("#memory-search-input")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "memory.search")).toBe(false);
  });
  it("names the search input for the selected scope", async () => {
    const element = mount(vi.fn().mockResolvedValue(snapshot()));
    await waitForFast(() => expect(element.querySelector("#memory-search-input")).not.toBeNull());
    element
      .querySelector("#vault-search-tab-selected")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() =>
      expect(element.querySelector('label[for="memory-search-input"]')?.textContent).toContain(
        "Search this vault’s document contents",
      ),
    );
    element
      .querySelector("#vault-search-tab-all")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() =>
      expect(element.querySelector('label[for="memory-search-input"]')?.textContent).toContain(
        "Search document contents",
      ),
    );
  });
  it("keeps a rejected connection unchanged and opens create/import in themed dialogs", async () => {
    const value = { ...snapshot(), selected: undefined };
    const request = vi.fn(async (method: string) => {
      if (method === `${rpc}connection.set`) {
        throw new Error("Access changed; refresh vaults");
      }
      return value;
    });
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    const toggle = element.querySelector("wa-switch") as HTMLElement & { checked: boolean };
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => expect(element.textContent).toContain("Access changed"));
    expect(toggle.checked).toBe(true);
    button(element, "Create Shared vault").click();
    await element.updateComplete;
    expect(
      element
        .querySelector("openclaw-modal-dialog input[name=name]")
        ?.classList.contains("settings-input"),
    ).toBe(true);
    button(element, "Cancel").click();
    await element.updateComplete;
    button(element, "Import ZIP as new vault").click();
    await element.updateComplete;
    expect(
      element.querySelector('openclaw-modal-dialog input[accept=".zip,application/zip"]'),
    ).not.toBeNull();
    expect(element.textContent).toContain("new Shared vault without merging");
  });
  it("keeps Reader viewing separate from whole-vault export and renders failed index provenance", async () => {
    const request = vi.fn(async (method: string) =>
      method === `${rpc}document.get` ? document : snapshot(false),
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    const labels = [...element.querySelectorAll("button")].map((item) => item.textContent?.trim());
    expect(labels).not.toContain("Write document");
    expect(labels).not.toContain("Download entire vault ZIP");
    expect(element.textContent).toContain("Index unavailable");
    expect(element.textContent?.replace(/\s+/gu, " ")).toContain("Indexed revision: 2");
    button(element, "Training").click();
    await waitForFast(() => expect(element.querySelector("[data-vault-document]")).not.toBeNull());
    expect(
      element.querySelector("[data-vault-document]")?.textContent?.replace(/\s+/gu, " "),
    ).toContain("vault-1 · doc-1");
    expect(
      [...element.querySelectorAll("button")].some(
        (candidate) => candidate.textContent?.trim() === "Download Markdown",
      ),
    ).toBe(false);
    expect(request).toHaveBeenLastCalledWith(`${rpc}document.get`, {
      vaultId: "vault-1",
      documentId: "doc-1",
    });
  });
  it("explains an empty Reader vault without suggesting unavailable editing actions", async () => {
    const value = snapshot(false);
    value.selected!.documents = [];
    const element = mount(vi.fn().mockResolvedValue(value));
    await waitForFast(() =>
      expect(element.textContent).toContain("An Editor or Owner can add knowledge"),
    );
    expect(element.textContent).not.toContain("Use Add knowledge");
    expect(
      [...element.querySelectorAll("button")].some(
        (item) => item.textContent?.trim() === "Add knowledge",
      ),
    ).toBe(false);
  });
  it("does not reopen a closed reader when a linked document finishes loading", async () => {
    let resolveLinked!: (value: KnowledgeVaultDocument) => void;
    const linked = new Promise<KnowledgeVaultDocument>((resolve) => {
      resolveLinked = resolve;
    });
    const first = {
      ...document,
      links: [
        { target: "linked.md", documentId: "doc-2", logicalPath: "linked.md", title: "Linked" },
      ],
    };
    const request = vi.fn(async (method: string, params?: { documentId?: string }) =>
      method === `${rpc}document.get`
        ? params?.documentId === "doc-2"
          ? linked
          : first
        : snapshot(),
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Training").click();
    await waitForFast(() => expect(element.querySelector("[data-vault-document]")).not.toBeNull());
    button(element, "Linked · linked.md").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}document.get`, {
        vaultId: "vault-1",
        documentId: "doc-2",
      }),
    );
    button(element, "Close document").click();
    resolveLinked({ ...document, id: "doc-2", title: "Linked" });
    await waitForFast(() => expect(element.querySelector("[data-vault-document]")).toBeNull());
    await element.updateComplete;
    expect(element.querySelector("[data-vault-document]")).toBeNull();
  });
  it.each(["close", "disconnect", "refresh"] as const)(
    "preserves saved reader lifecycle during %s while its list refresh is pending",
    async (action) => {
      let saved = false;
      let resolveRefresh!: (value: KnowledgeVaultSnapshot) => void;
      const refresh = new Promise<KnowledgeVaultSnapshot>((resolve) => {
        resolveRefresh = resolve;
      });
      const request = vi.fn(async (method: string) => {
        if (method === `${rpc}document.get`) {
          return document;
        }
        if (method === `${rpc}document.preview`) {
          return { title: "Updated", logicalPath: document.logicalPath };
        }
        if (method === `${rpc}document.save`) {
          saved = true;
          return { ...document, title: "Updated", revision: 4 };
        }
        return saved ? refresh : snapshot();
      });
      const element = mount(request);
      await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
      button(element, "Training").click();
      await waitForFast(() =>
        expect(element.querySelector("[data-vault-document]")).not.toBeNull(),
      );
      button(element, "Edit document").click();
      await waitForFast(() => expect(element.querySelector("[data-vault-editor]")).not.toBeNull());
      const form = element.querySelector<HTMLFormElement>("[data-vault-editor]")!;
      fill(form, "title", "Updated");
      submit(form);
      await waitForFast(() =>
        expect(element.querySelector(".vaults__author-preview")).not.toBeNull(),
      );
      submit(form);
      await waitForFast(() =>
        expect(
          element.querySelector("[data-vault-document] .dreams-diary__preview-title")?.textContent,
        ).toBe("Updated"),
      );
      expect(button(element, "Edit document").disabled).toBe(true);
      expect(button(element, "Close document").disabled).toBe(false);
      if (action === "refresh") {
        resolveRefresh(snapshot());
        await waitForFast(() => expect(button(element, "Edit document").disabled).toBe(false));
        return;
      }
      if (action === "close") {
        button(element, "Close document").click();
      } else {
        element.connected = false;
        await waitForFast(() => expect(button(element, "Edit document").disabled).toBe(true));
        resolveRefresh(snapshot());
        await refresh;
        await element.updateComplete;
        expect(element.querySelector("[data-vault-document]")?.textContent).toContain("Updated");
        expect(button(element, "Close document").disabled).toBe(false);
        button(element, "Close document").click();
      }
      await waitForFast(() =>
        expect(element.querySelector("platformclaw-vault-reader")).toBeNull(),
      );
      resolveRefresh(snapshot());
      await refresh;
      await element.updateComplete;
      expect(element.querySelector("platformclaw-vault-reader")).toBeNull();
      if (action === "close") {
        expect(element.textContent).toContain("Updated");
      } else {
        expect(element.textContent).toContain("PHY Spec");
      }
    },
  );
  it("requires an explicit discard for source replacement and close, preserving the draft on cancellation", async () => {
    const element = mount(vi.fn().mockResolvedValue(snapshot()));
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Add knowledge").click();
    await waitForFast(() => expect(element.querySelector("[data-vault-editor]")).not.toBeNull());
    fill(element, "title", "Unsaved title");
    fill(element, "content", "# Unsaved body");
    fill(element, "path", "draft.md");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    element
      .querySelector("#vault-author-source-tab-upload")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() => expect(element.textContent).toContain("Discard unsaved changes?"));
    button(element, "Keep editing").click();
    await waitForFast(() =>
      expect(element.querySelector<HTMLInputElement>("[name=title]")?.value).toBe("Unsaved title"),
    );
    expect(element.querySelector<HTMLTextAreaElement>("[name=content]")?.value).toBe(
      "# Unsaved body",
    );
    expect(element.querySelector<HTMLInputElement>("[name=path]")?.value).toBe("draft.md");
    button(element, "Cancel").click();
    await waitForFast(() => expect(element.textContent).toContain("Discard unsaved changes?"));
    const escape = new CustomEvent("modal-cancel", { bubbles: true, cancelable: true });
    element.querySelector("openclaw-modal-dialog")!.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    await waitForFast(() =>
      expect(element.querySelector<HTMLInputElement>("[name=title]")?.value).toBe("Unsaved title"),
    );
    button(element, "Cancel").click();
    await waitForFast(() => expect(element.textContent).toContain("Discard unsaved changes?"));
    button(element, "Discard changes").click();
    await waitForFast(() => expect(element.querySelector("platformclaw-vault-author")).toBeNull());
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });
  it("keeps a dirty Personal copy and its original revision when a replacement source is cleared or cancelled", async () => {
    const element = mount(vi.fn().mockResolvedValue(snapshot()));
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Add knowledge").click();
    await waitForFast(() =>
      expect(element.querySelector("#vault-author-source-tab-personal")).not.toBeNull(),
    );
    element
      .querySelector("#vault-author-source-tab-personal")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() =>
      expect(element.querySelector("openclaw-memory-promotion-source-picker")).not.toBeNull(),
    );
    const select = (title: string) =>
      element.querySelector("openclaw-memory-promotion-source-picker")!.dispatchEvent(
        new CustomEvent("source-selected", {
          bubbles: true,
          detail: {
            title,
            lookup: `${title}.md`,
            path: `${title}.md`,
            content: title,
            sourceContent: title,
          },
        }),
      );
    select("Original");
    await waitForFast(() => expect(element.querySelector("[data-vault-editor]")).not.toBeNull());
    fill(element, "content", "Edited private copy");
    button(element, "Choose another Personal document").click();
    await waitForFast(() =>
      expect(element.querySelector("openclaw-memory-promotion-source-picker")).not.toBeNull(),
    );
    element
      .querySelector("openclaw-memory-promotion-source-picker")!
      .dispatchEvent(new CustomEvent("source-cleared", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector<HTMLTextAreaElement>("[name=content]")?.value).toBe(
      "Edited private copy",
    );
    select("Replacement");
    await waitForFast(() => expect(element.textContent).toContain("Discard unsaved changes?"));
    button(element, "Keep editing").click();
    await waitForFast(() =>
      expect(element.querySelector<HTMLInputElement>("[name=title]")?.value).toBe("Original"),
    );
    expect(element.querySelector<HTMLTextAreaElement>("[name=content]")?.value).toBe(
      "Edited private copy",
    );
  });
  it("preserves an edited upload when replacement is cancelled or decoding fails", async () => {
    const request = vi.fn(async (method: string) =>
      method === `${rpc}document.preview`
        ? { title: "Original upload", logicalPath: "original.md" }
        : snapshot(),
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Add knowledge").click();
    await waitForFast(() =>
      expect(element.querySelector("#vault-author-source-tab-upload")).not.toBeNull(),
    );
    element
      .querySelector("#vault-author-source-tab-upload")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() =>
      expect(element.querySelector('input[accept=".md,.markdown,text/markdown"]')).not.toBeNull(),
    );
    const upload = (name: string, bytes: Uint8Array) => {
      const file = new File([], name, { type: "text/markdown" });
      Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
      const input = element.querySelector<HTMLInputElement>(
        'input[accept=".md,.markdown,text/markdown"]',
      )!;
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    upload("original.md", new TextEncoder().encode("# Original"));
    await waitForFast(() =>
      expect(element.querySelector(".vaults__author-preview")).not.toBeNull(),
    );
    button(element, "Edit content").click();
    await waitForFast(() => expect(element.querySelector("[name=content]")).not.toBeNull());
    fill(element, "content", "Edited upload");
    upload("replacement.md", new TextEncoder().encode("# Replacement"));
    await waitForFast(() => expect(element.textContent).toContain("Discard unsaved changes?"));
    button(element, "Keep editing").click();
    await waitForFast(() =>
      expect(element.querySelector<HTMLTextAreaElement>("[name=content]")?.value).toBe(
        "Edited upload",
      ),
    );
    expect(element.textContent).toContain("original.md");
    upload("invalid.md", Uint8Array.of(0xff));
    await waitForFast(() => expect(element.textContent).toContain("Discard unsaved changes?"));
    button(element, "Discard changes").click();
    await waitForFast(() => expect(element.textContent).toContain("Markdown must be valid UTF-8"));
    expect(element.querySelector<HTMLTextAreaElement>("[name=content]")?.value).toBe(
      "Edited upload",
    );
    expect(element.textContent).toContain("original.md");
  });
  it("edits a cross-vault search result in its own vault while preserving the original search", async () => {
    const value = snapshot();
    value.vaults.push({ ...value.vaults[0]!, id: "vault-2", name: "Other project" });
    const target = { ...document, id: "doc-2", vaultId: "vault-2", title: "Other training" };
    const request = vi.fn(async (method: string) => {
      if (method === "memory.search") {
        return {
          agentId: "personal-a",
          results: [
            {
              vaultId: "vault-2",
              vaultName: "Other project",
              vaultType: "shared",
              documentId: "doc-2",
              title: target.title,
              path: "shared/vault-2/doc-2",
              snippet: "Training",
              revision: 3,
              source: "shared",
              score: 1,
              startLine: 1,
              endLine: 1,
            },
          ],
        };
      }
      if (method === `${rpc}document.get` || method === `${rpc}document.save`) {
        return target;
      }
      if (method === `${rpc}document.preview`) {
        return { title: target.title, logicalPath: target.logicalPath };
      }
      return value;
    });
    const element = mount(request);
    await waitForFast(() => expect(element.querySelector("#memory-search-input")).not.toBeNull());
    const query = element.querySelector<HTMLInputElement>("#memory-search-input")!;
    query.value = "training";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    submit(query.closest("form")!);
    await waitForFast(() =>
      expect(
        element.querySelector("openclaw-memory-memories .memory-memories__result > button"),
      ).not.toBeNull(),
    );
    (
      element.querySelector(
        "openclaw-memory-memories .memory-memories__result > button",
      ) as HTMLButtonElement
    ).click();
    await waitForFast(() =>
      expect(element.querySelector("[data-vault-document]")?.textContent).toContain(
        "Other project",
      ),
    );
    button(element, "Edit document").click();
    await waitForFast(() => expect(element.querySelector("[data-vault-editor]")).not.toBeNull());
    const form = element.querySelector<HTMLFormElement>("[data-vault-editor]")!;
    fill(form, "content", "# Updated other project");
    submit(form);
    await waitForFast(() =>
      expect(element.querySelector(".vaults__author-preview")).not.toBeNull(),
    );
    submit(form);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}document.save`, {
        vaultId: "vault-2",
        documentId: "doc-2",
        expectedRevision: 3,
        title: target.title,
        logicalPath: target.logicalPath,
        content: "# Updated other project",
      }),
    );
    await waitForFast(() => expect(element.querySelector("platformclaw-vault-author")).toBeNull());
    expect(element.querySelector(".vaults__selected > header h2")?.textContent).toBe("PHY Spec");
    expect(element.querySelector<HTMLInputElement>("#memory-search-input")).toBe(query);
    expect(query.value).toBe("training");
  });
  it("saves exact original bytes with revision, retaining edits when save conflicts", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === `${rpc}document.get`) {
        return document;
      }
      if (method === `${rpc}document.preview`) {
        return { title: "Training", logicalPath: "guides/moved.md" };
      }
      if (method === `${rpc}document.save`) {
        throw new Error("Document changed; reload before saving");
      }
      return snapshot();
    });
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Training").click();
    await waitForFast(() => expect(element.querySelector("[data-vault-document]")).not.toBeNull());
    button(element, "Edit document").click();
    await waitForFast(() => expect(element.querySelector("[data-vault-editor]")).not.toBeNull());
    const form = element.querySelector("[data-vault-editor]") as HTMLFormElement;
    const original = "# Authored\n\n  Keep trailing spaces.  \n";
    fill(form, "content", original);
    fill(form, "path", "guides/moved.md");
    submit(form);
    await waitForFast(() =>
      expect(element.querySelector(".vaults__author-preview")).not.toBeNull(),
    );
    submit(form);
    await waitForFast(() =>
      expect(element.textContent).toContain("Document changed; reload before saving"),
    );
    expect(request).toHaveBeenLastCalledWith(`${rpc}document.save`, {
      vaultId: "vault-1",
      documentId: "doc-1",
      title: "Training",
      logicalPath: "guides/moved.md",
      content: original,
      expectedRevision: 3,
    });
    button(element, "Edit content").click();
    await waitForFast(() =>
      expect(element.querySelector<HTMLTextAreaElement>("[name=content]")?.value).toBe(original),
    );
  });
  it.each(["upload", "edit"] as const)(
    "preserves unchanged UTF-8 BOM and CRLF through %s",
    async (mode) => {
      const content = "\uFEFF# Original\r\n\r\n  Keep spaces.  \r\n";
      const request = vi.fn(async (method: string) =>
        method === `${rpc}document.get`
          ? { ...document, content }
          : method === `${rpc}document.preview`
            ? { title: "Original", logicalPath: "original.md" }
            : method === `${rpc}document.save`
              ? { ...document, content }
              : snapshot(),
      );
      const element = mount(request);
      await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
      if (mode === "edit") {
        button(element, "Training").click();
        await waitForFast(() =>
          expect(element.querySelector("[data-vault-document]")).not.toBeNull(),
        );
        button(element, "Edit document").click();
      } else {
        button(element, "Add knowledge").click();
        await waitForFast(() =>
          expect(element.querySelector("#vault-author-source-tab-upload")).not.toBeNull(),
        );
        element
          .querySelector("#vault-author-source-tab-upload")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
        await waitForFast(() =>
          expect(
            element.querySelector('input[accept=".md,.markdown,text/markdown"]'),
          ).not.toBeNull(),
        );
        const file = new File([], "original.markdown", { type: "text/markdown" });
        Object.defineProperty(file, "arrayBuffer", {
          value: async () => new TextEncoder().encode(content).buffer,
        });
        const input = element.querySelector<HTMLInputElement>(
          'input[accept=".md,.markdown,text/markdown"]',
        )!;
        Object.defineProperty(input, "files", { value: [file] });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await waitForFast(() => expect(element.querySelector("[data-vault-editor]")).not.toBeNull());
      if (mode === "edit") {
        expect(element.querySelector<HTMLTextAreaElement>("[name=content]")?.value).toBe(
          content.replaceAll("\r\n", "\n"),
        );
        submit(element.querySelector<HTMLFormElement>("[data-vault-editor]")!);
        await waitForFast(() =>
          expect(element.querySelector(".vaults__author-preview")).not.toBeNull(),
        );
      } else {
        await waitForFast(() =>
          expect(element.querySelector(".vaults__author-preview")).not.toBeNull(),
        );
        expect(element.querySelector<HTMLInputElement>("[name=title]")?.value).toBe("Original");
      }
      submit(element.querySelector<HTMLFormElement>("[data-vault-editor]")!);
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith(
          `${rpc}document.save`,
          expect.objectContaining({ content }),
        ),
      );
    },
  );
  it("rejects malformed UTF-8 without replacing the uploaded source", async () => {
    const request = vi.fn().mockResolvedValue(snapshot());
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Add knowledge").click();
    await waitForFast(() =>
      expect(element.querySelector("#vault-author-source-tab-upload")).not.toBeNull(),
    );
    element
      .querySelector("#vault-author-source-tab-upload")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() =>
      expect(element.querySelector('input[accept=".md,.markdown,text/markdown"]')).not.toBeNull(),
    );
    const file = new File([], "invalid.md", { type: "text/markdown" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => Uint8Array.of(0xff).buffer });
    const input = element.querySelector<HTMLInputElement>(
      'input[accept=".md,.markdown,text/markdown"]',
    )!;
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => expect(element.textContent).toContain("Markdown must be valid UTF-8"));
    expect(element.querySelector("[data-vault-editor]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === `${rpc}document.save`)).toBe(false);
  });

  it("selects private knowledge by search, reviews an editable copy and pins the original hash", async () => {
    const sourceContent = "# Private\nOriginal";
    const request = vi.fn(async (method: string) => {
      if (method === "wiki.search") {
        return [{ path: "concepts/training.md", title: "Private training", snippet: "Original" }];
      }
      if (method === "wiki.document.get") {
        return {
          path: "concepts/training.md",
          title: "Private training",
          sourceContent,
          displayContent: sourceContent,
        };
      }
      if (method === `${rpc}document.preview`) {
        return { title: "Shared training", logicalPath: "training.md" };
      }
      if (method === `${rpc}publish`) {
        return document;
      }
      return snapshot();
    });
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Add knowledge").click();
    await waitForFast(() =>
      expect(element.querySelector("#vault-author-source-tab-personal")).not.toBeNull(),
    );
    element
      .querySelector("#vault-author-source-tab-personal")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() => expect(element.querySelector("#memory-source-query")).not.toBeNull());
    const query = element.querySelector<HTMLInputElement>("#memory-source-query")!;
    query.value = "training";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    submit(query.closest("form")!);
    await waitForFast(() =>
      expect(element.querySelector(".memory-source-picker__result")).not.toBeNull(),
    );
    (element.querySelector(".memory-source-picker__result") as HTMLButtonElement).click();
    await waitForFast(() => expect(element.querySelector("[data-vault-editor]")).not.toBeNull());
    expect(request).toHaveBeenCalledWith("wiki.search", {
      agentId: "personal-a",
      vaultId: "personal:personal-a",
      query: "training",
      maxResults: 20,
    });
    const form = element.querySelector<HTMLFormElement>("[data-vault-editor]")!;
    fill(form, "title", "Shared training");
    fill(form, "content", "# Shared\nSafe copy");
    submit(form);
    await waitForFast(() =>
      expect(element.querySelector(".vaults__author-preview")).not.toBeNull(),
    );
    expect(request.mock.calls.some(([method]) => method === `${rpc}publish`)).toBe(false);
    submit(form);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}publish`, {
        lookup: "concepts/training.md",
        targetVaultId: "vault-1",
        title: "Shared training",
        content: "# Shared\nSafe copy",
        expectedRevision: createHash("sha256").update(sourceContent).digest("hex"),
      }),
    );
    expect(request.mock.calls.some(([method]) => method === "wiki.document.update")).toBe(false);
  });
  it("uses the same reader and editable body for Personal without exposing claims on cards", async () => {
    const current = wikiHubSnapshot({ selectedId: wikiHubPersonalId });
    const request = vi.fn(async (method: string) =>
      method === `${rpc}document.get`
        ? wikiHubPersonalDocument
        : method === `${rpc}document.preview`
          ? { title: "Reviewed personal title", logicalPath: "" }
          : method === `${rpc}document.save`
            ? { ...wikiHubPersonalDocument, title: "Reviewed personal title" }
            : current,
    );
    const element = mount(request);
    await waitForFast(() =>
      expect(element.querySelectorAll(".wiki-hub__document-card")).toHaveLength(2),
    );
    expect(element.textContent).not.toContain("Should each canary");
    expect(button(element, "Download entire vault ZIP")).toBeDefined();
    expect(element.querySelector('input[type="file"]')).not.toBeNull();
    button(element, wikiHubPersonalDocument.title).click();
    await waitForFast(() => expect(element.querySelector("[data-vault-document]")).not.toBeNull());
    expect(
      element.querySelector("[data-vault-document] details:last-child")?.textContent,
    ).toContain("Should each canary");
    button(element, "Edit document").click();
    await waitForFast(() => expect(element.querySelector("[data-vault-editor]")).not.toBeNull());
    expect(element.querySelector<HTMLTextAreaElement>("[name=content]")!.value).toBe(
      wikiHubPersonalDocument.editableContent,
    );
    expect(element.querySelector("[name=path]")).toBeNull();
    fill(element, "title", "Reviewed personal title");
    submit(element.querySelector<HTMLFormElement>("[data-vault-editor]")!);
    await waitForFast(() =>
      expect(element.querySelector(".vaults__author-preview")).not.toBeNull(),
    );
    submit(element.querySelector<HTMLFormElement>("[data-vault-editor]")!);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}document.save`, {
        vaultId: wikiHubPersonalId,
        documentId: wikiHubPersonalDocument.id,
        expectedRevision: wikiHubPersonalDocument.revision,
        title: "Reviewed personal title",
        content: wikiHubPersonalDocument.editableContent,
      }),
    );
  });
  it.each(["personal", "shared"] as const)(
    "deletes %s documents only after confirmation, retains errors and refreshes the list",
    async (kind) => {
      let current =
        kind === "personal" ? wikiHubSnapshot({ selectedId: wikiHubPersonalId }) : snapshot();
      const doc = kind === "personal" ? wikiHubPersonalDocument : document;
      let rejected = true;
      const request = vi.fn(async (method: string) => {
        if (method === `${rpc}document.get`) {
          return doc;
        }
        if (method === `${rpc}document.delete`) {
          if (rejected) {
            throw new Error("Revision changed");
          }
          current = { ...current, selected: { ...current.selected!, documents: [] } };
          return {};
        }
        return current;
      });
      const element = mount(request);
      await waitForFast(() =>
        expect(element.querySelector(".wiki-hub__document-card")).not.toBeNull(),
      );
      button(element, doc.title).click();
      await waitForFast(() =>
        expect(element.querySelector("[data-vault-document]")).not.toBeNull(),
      );
      button(element, "Delete document").click();
      await waitForFast(() =>
        expect(element.querySelector("button.danger:not(.btn--subtle)")).not.toBeNull(),
      );
      expect(request.mock.calls.some(([method]) => method === `${rpc}document.delete`)).toBe(false);
      button(element, "Delete document").click();
      await waitForFast(() => expect(element.textContent).toContain("Revision changed"));
      rejected = false;
      button(element, "Delete document").click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith(`${rpc}document.delete`, {
          vaultId: doc.vaultId,
          documentId: doc.id,
          expectedRevision: doc.revision,
        }),
      );
      await waitForFast(() =>
        expect(element.querySelector("platformclaw-vault-reader")).toBeNull(),
      );
      expect(element.textContent).toContain("Document deleted");
    },
  );
  it("writes Personal through the same author without a manual path or publish-to-self choice", async () => {
    const value = wikiHubSnapshot({ selectedId: wikiHubPersonalId });
    const request = vi.fn(async (method: string) =>
      method === `${rpc}document.preview`
        ? { title: "Personal authored title", logicalPath: "" }
        : method === `${rpc}document.save`
          ? { ...wikiHubPersonalDocument, title: "Personal authored title" }
          : value,
    );
    const element = mount(request);
    await waitForFast(() =>
      expect(element.querySelector(".wiki-hub__document-card")).not.toBeNull(),
    );
    button(element, "Add knowledge").click();
    await waitForFast(() => expect(element.querySelector("[data-vault-editor]")).not.toBeNull());
    expect(element.querySelector("#vault-author-source-tab-personal")).toBeNull();
    expect(element.querySelector("[name=path]")).toBeNull();
    fill(element, "title", "Personal authored title");
    fill(element, "content", "# My exact body");
    submit(element.querySelector<HTMLFormElement>("[data-vault-editor]")!);
    await waitForFast(() =>
      expect(element.querySelector(".vaults__author-preview")).not.toBeNull(),
    );
    submit(element.querySelector<HTMLFormElement>("[data-vault-editor]")!);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}document.save`, {
        vaultId: wikiHubPersonalId,
        title: "Personal authored title",
        content: "# My exact body",
      }),
    );
  });
  it("clears private contents when disconnected and ignores a late snapshot", async () => {
    let resolve!: (value: KnowledgeVaultSnapshot) => void;
    const request = vi.fn(
      () =>
        new Promise<KnowledgeVaultSnapshot>((done) => {
          resolve = done;
        }),
    );
    const element = mount(request);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    element.connected = false;
    await element.updateComplete;
    resolve(snapshot());
    await Promise.resolve();
    await element.updateComplete;
    expect(element.textContent).not.toContain("PHY Spec");
    expect(element.textContent).toContain("Wiki Hub is unavailable");
  });
});
