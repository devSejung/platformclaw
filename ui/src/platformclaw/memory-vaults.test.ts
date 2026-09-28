/* @vitest-environment jsdom */
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeVaultDocument,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import "./memory-vaults.ts";

type VaultElement = HTMLElement & {
  client: GatewayBrowserClient;
  connected: boolean;
  methodAdvertised: boolean;
  agentId: string;
  methods: string[];
  updateComplete: Promise<unknown>;
};
const rpc = "platformclaw.vault.";
const document: KnowledgeVaultDocument = {
  id: "doc-1",
  vaultId: "vault-1",
  title: "Training",
  logicalPath: "training.md",
  revision: 3,
  updatedAt: 100,
  content: "# Training\n\n  Keep source whitespace.  \n",
  links: [],
  backlinks: [],
  compile: {
    status: "failed",
    indexedRevision: 2,
    error: "Index unavailable",
    attempts: 1,
    retryAt: 200,
  },
};
function snapshot(owner = true): KnowledgeVaultSnapshot {
  const vault = {
    id: "vault-1",
    name: "PHY Spec",
    description: "Hardware notes",
    type: "shared" as const,
    role: owner ? ("owner" as const) : ("reader" as const),
    canEdit: owner,
    canManageMembers: owner,
    canExport: false,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    selectionRevision: 1,
    vaults: [{ ...vault, connected: true, documentCount: 1, attachmentCount: 0 }],
    selected: {
      vault,
      documents: [document],
      graph: { edges: [], unresolvedLinks: 0, truncated: false },
      members: [
        {
          userId: "u-reader",
          accountId: "reader",
          displayName: "Reader User",
          role: "reader",
          canExport: false,
        },
      ],
      attachments: [],
    },
  };
}
function mount(request: ReturnType<typeof vi.fn>) {
  const element = globalThis.document.createElement("platformclaw-memory-vaults") as VaultElement;
  Object.assign(element, {
    client: { request },
    connected: true,
    methodAdvertised: true,
    agentId: "personal-a",
    methods: [
      "memory.search",
      "wiki.search",
      "wiki.document.get",
      `${rpc}document.get`,
      `${rpc}document.save`,
      `${rpc}document.preview`,
      `${rpc}publish`,
    ],
  });
  globalThis.document.body.append(element);
  return element;
}
function button(element: HTMLElement, text: string) {
  const value = [...element.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(value, text).toBeDefined();
  return value!;
}
function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
function fill(form: Element, name: string, value: string) {
  const input = form.querySelector(`[name="${name}"]`) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});
afterEach(() => {
  globalThis.document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Shared Knowledge Vault UI", () => {
  it("finds authorized Shared and Managed vaults and applies server-confirmed connections", async () => {
    let state = snapshot();
    state = {
      ...state,
      selected: undefined,
      vaults: [
        { ...state.vaults[0]!, connected: false },
        {
          ...state.vaults[0]!,
          id: "managed:team:one",
          name: "Team Handbook",
          type: "managed",
          connected: false,
          canEdit: false,
          canManageMembers: false,
          canExport: false,
        },
      ],
    };
    const request = vi.fn(
      async (method: string, params: { vaultId?: string; connected?: boolean }) => {
        if (method === `${rpc}connection.set`) {
          state = {
            ...state,
            selectionRevision: state.selectionRevision + 1,
            vaults: state.vaults.map((vault) =>
              vault.id === params.vaultId ? { ...vault, connected: params.connected! } : vault,
            ),
          };
        }
        return state;
      },
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("My personal knowledge"));
    expect(element.querySelectorAll("[data-vault-card]")).toHaveLength(1);
    element
      .querySelector("#vault-catalog-tab-discover")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-vault-card]")).toHaveLength(2);
    const input = element.querySelector<HTMLInputElement>("input[type=search]")!;
    input.value = "Handbook";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-vault-card]")).toHaveLength(1);
    button(element, "Add to my vaults").click();
    await waitForFast(() =>
      expect(element.textContent).toContain(
        "Connected. Your AI can reference this vault from your next turn.",
      ),
    );
    expect(request).toHaveBeenCalledWith(`${rpc}connection.set`, {
      vaultId: "managed:team:one",
      connected: true,
    });
    expect(element.textContent).toContain("AI reference enabled");
    button(element, "Disconnect").click();
    await waitForFast(() =>
      expect(element.textContent).toContain("Disconnected for your next turn"),
    );
    expect(request).toHaveBeenCalledWith(`${rpc}connection.set`, {
      vaultId: "managed:team:one",
      connected: false,
    });
    expect(element.textContent).toContain("Not connected");
    expect(element.textContent).not.toContain("Delete vault");
    element.connected = false;
    await element.updateComplete;
    state = { ...state, vaults: [] };
    element.connected = true;
    await element.updateComplete;
    await waitForFast(() => expect(element.textContent).not.toContain("Team Handbook"));
  });
  it("finds the Personal card by its visible name without a contradictory empty result", async () => {
    const value = { ...snapshot(), selected: undefined };
    const element = mount(vi.fn().mockResolvedValue(value));
    await waitForFast(() =>
      expect(element.querySelector('[data-vault-card="personal"]')).not.toBeNull(),
    );
    const query = element.querySelector<HTMLInputElement>(".vaults__catalog-search input")!;
    query.value = "My personal knowledge";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector('[data-vault-card="personal"]')).not.toBeNull();
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
    button(element, "Disconnect").click();
    await waitForFast(() => expect(element.textContent).toContain("Access changed"));
    expect(element.textContent).toContain("AI reference enabled");
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
    expect(button(element, "Download Markdown")).toBeDefined();
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
      links: [{ documentId: "doc-2", logicalPath: "linked.md", title: "Linked" }],
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
      button(element, "Edit / move").click();
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
      expect(button(element, "Edit / move").disabled).toBe(true);
      expect(button(element, "Close document").disabled).toBe(false);
      if (action === "refresh") {
        resolveRefresh(snapshot());
        await waitForFast(() => expect(button(element, "Edit / move").disabled).toBe(false));
        return;
      }
      if (action === "close") {
        button(element, "Close document").click();
      } else {
        element.connected = false;
      }
      await waitForFast(() =>
        expect(element.querySelector("platformclaw-vault-reader")).toBeNull(),
      );
      resolveRefresh(snapshot());
      await refresh;
      await element.updateComplete;
      expect(element.querySelector("platformclaw-vault-reader")).toBeNull();
      if (action === "disconnect") {
        expect(element.textContent).not.toContain("PHY Spec");
      } else {
        expect(element.textContent).toContain("Updated");
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
      expect(element.querySelector(".memory-memories__result > button")).not.toBeNull(),
    );
    (element.querySelector(".memory-memories__result > button") as HTMLButtonElement).click();
    await waitForFast(() =>
      expect(element.querySelector("[data-vault-document]")?.textContent).toContain(
        "Other project",
      ),
    );
    button(element, "Edit / move").click();
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
    button(element, "Edit / move").click();
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
        button(element, "Edit / move").click();
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
  it("assigns employee account role and export permission independently", async () => {
    const request = vi.fn().mockResolvedValue(snapshot());
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Members and permissions").click();
    await waitForFast(() => expect(element.querySelector("[name=accountId]")).not.toBeNull());
    const form = element.querySelector("[name=accountId]")!.closest("form")!;
    fill(form, "accountId", "engineer");
    fill(form, "role", "editor");
    submit(form);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}member.set`, {
        vaultId: "vault-1",
        accountId: "engineer",
        role: "editor",
        canExport: false,
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
    expect(element.textContent).toContain("Memory Hub is unavailable");
  });
});
