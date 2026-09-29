/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeVaultDocument } from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { i18n } from "../i18n/index.ts";
import {
  wikiHubSnapshot,
  wikiHubPersonalId,
  wikiHubPersonalDocument,
  wikiHubSharedDocument,
  wikiHubMethods,
} from "../test-helpers/platformclaw-wiki-hub-fixture.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import { renderVaultDocument, renderVaultDocumentList } from "./memory-vault-document.ts";
import "./memory-vault-author.ts";

const rpc = "platformclaw.vault.document.";
function button(root: Element, name: string) {
  const match = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name,
  );
  expect(match, name).toBeDefined();
  return match!;
}
function mount(request: ReturnType<typeof vi.fn>, personal: boolean, editing: boolean) {
  const vault = wikiHubSnapshot().vaults.find(
    (item) => item.id === (personal ? wikiHubPersonalId : "vault-phy"),
  )!;
  const host = document.createElement("div");
  document.body.append(host);
  render(
    html`<platformclaw-vault-author
      .client=${{ request }}
      .connected=${true}
      .methods=${wikiHubMethods}
      .agentId=${"assigned-personal"}
      .vault=${vault}
      .document=${editing ? (personal ? wikiHubPersonalDocument : wikiHubSharedDocument) : null}
    ></platformclaw-vault-author>`,
    host,
  );
  return host;
}
beforeEach(async () => {
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Wiki document links", () => {
  it.each([
    { personal: true, editing: false },
    { personal: true, editing: true },
    { personal: false, editing: false },
    { personal: false, editing: true },
  ])(
    "inserts server links at selection without losing the $personal/$editing draft",
    async ({ personal, editing }) => {
      const link = "[[guides/Setup%20%23%25.md|Setup guide]]";
      const request = vi.fn(async (_method: string, _params: unknown) => ({
        items: [
          { documentId: "target", title: "Setup guide", logicalPath: "guides/Setup #%.md", link },
        ],
        hasMore: false,
      }));
      const host = mount(request, personal, editing);
      await waitForFast(() => expect(host.querySelector("textarea")).not.toBeNull());
      const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.value = "Before replace after";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
      textarea.setSelectionRange(7, 14);
      button(host, "Document link").click();
      await waitForFast(() =>
        expect(
          host.querySelector("platformclaw-vault-link-picker button.settings-row"),
        ).not.toBeNull(),
      );
      expect(request).toHaveBeenLastCalledWith(rpc + "targets", {
        vaultId: personal ? wikiHubPersonalId : "vault-phy",
        query: "",
      });
      (host.querySelector("button.settings-row") as HTMLButtonElement).click();
      await waitForFast(() =>
        expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
          "Before " + link + " after",
        ),
      );
      const restored = host.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(document.activeElement).toBe(restored);
      expect(restored.selectionStart).toBe(7 + link.length);
      button(host, "Document link").click();
      await waitForFast(() => expect(host.querySelector("button.settings-row")).not.toBeNull());
      (host.querySelector("button.settings-row") as HTMLButtonElement).click();
      await waitForFast(() =>
        expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
          "Before " + link + link + " after",
        ),
      );
      button(host, "Document link").click();
      await waitForFast(() =>
        expect(host.querySelector("platformclaw-vault-link-picker")).not.toBeNull(),
      );
      button(host, "Back to draft").click();
      await waitForFast(() =>
        expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
          "Before " + link + link + " after",
        ),
      );
      button(host, "Cancel").click();
      await waitForFast(() => expect(host.textContent).toContain("Discard unsaved changes"));
      expect(request.mock.calls.every(([method]) => method === rpc + "targets")).toBe(true);
    },
  );

  it("shows empty and retry states while preserving a dirty draft", async () => {
    let fail = false;
    const request = vi.fn(async (_method: string, _params: unknown) => {
      if (fail) {
        throw new Error("Search interrupted");
      }
      return { items: [], hasMore: false };
    });
    const host = mount(request, false, false);
    await waitForFast(() => expect(host.querySelector("textarea")).not.toBeNull());
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Do not lose this";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    button(host, "Document link").click();
    await waitForFast(() => expect(host.textContent).toContain("No matching documents"));
    fail = true;
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "setup";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForFast(() => expect(host.textContent).toContain("Search interrupted"));
    fail = false;
    button(host, "Retry").click();
    await waitForFast(() => expect(host.textContent).toContain("No matching documents"));
    button(host, "Back to draft").click();
    await waitForFast(() =>
      expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Do not lose this"),
    );
  });

  it.each(["personal", "shared"] as const)("renders body snippets on %s cards", (type) => {
    const host = document.createElement("div");
    document.body.append(host);
    const doc = type === "personal" ? wikiHubPersonalDocument : wikiHubSharedDocument;
    render(
      renderVaultDocumentList({
        documents: [doc],
        vaultName: "Example",
        vaultType: type,
        canEdit: true,
        busy: false,
        onOpen: vi.fn(),
      }),
      host,
    );
    expect(
      host.querySelector(".memory-memories__snippet")?.textContent ?? host.textContent,
    ).toContain(doc.snippet);
    expect(host.textContent).not.toContain(doc.logicalPath);
    expect(host.textContent).not.toContain(String(doc.revision));
    const row = host.querySelector(".settings-row__text")!;
    expect(row.children[1]?.classList.contains("memory-memories__snippet")).toBe(true);
  });
  it.each(["personal", "shared"] as const)(
    "opens canonical, aliased and relative links through %s server mappings",
    (type) => {
      const host = document.createElement("div");
      document.body.append(host);
      const open = vi.fn();
      const doc: KnowledgeVaultDocument = {
        ...(type === "personal" ? wikiHubPersonalDocument : wikiHubSharedDocument),
        logicalPath: "guides/source.md",
        content:
          "[[guides/Setup%20%23%25.md|Setup guide]] [[Shared title]] [[target-id|Identity]] [Relative](other.md) [[Ambiguous]]",
        links: [
          {
            target: "guides/Setup #%.md",
            logicalPath: "guides/Setup #%.md",
            documentId: "special",
            title: "Setup guide",
          },
          {
            target: "Shared title",
            logicalPath: "guides/title.md",
            documentId: "title",
            title: "Shared title",
          },
          {
            target: "target-id",
            logicalPath: "guides/id.md",
            documentId: "target-id",
            title: "Identity",
          },
          {
            target: "guides/other.md",
            logicalPath: "guides/other.md",
            documentId: "relative",
            title: "Relative",
          },
          { target: "Ambiguous", logicalPath: "Ambiguous", documentId: null, title: "Ambiguous" },
        ],
      };
      render(
        renderVaultDocument({
          document: doc,
          vaultName: "Example",
          vaultType: type,
          canExport: true,
          canEdit: true,
          busy: false,
          onOpen: open,
          onEdit: vi.fn(),
          onDownload: vi.fn(),
          onClose: vi.fn(),
        }),
        host,
      );
      for (const anchor of host.querySelectorAll<HTMLAnchorElement>("article a")) {
        anchor.click();
      }
      expect(open.mock.calls.map(([id]) => id)).toEqual([
        "special",
        "title",
        "target-id",
        "relative",
      ]);
      expect(host.querySelector("p.callout[role=status]")).not.toBeNull();
    },
  );
});
