/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeVaultSnapshot } from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { i18n } from "../i18n/index.ts";
import {
  wikiHubPersonalId,
  wikiHubSnapshot,
} from "../test-helpers/platformclaw-wiki-hub-fixture.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import "./memory-vault-document-actions.ts";
import type { VaultDocumentContext } from "./memory-vault-document-actions.ts";

type Selected = NonNullable<KnowledgeVaultSnapshot["selected"]>;
type Element = HTMLElement & {
  selected: Selected;
  context: VaultDocumentContext;
  busy: boolean;
  updateComplete: Promise<unknown>;
};
beforeEach(async () => {
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
async function mount(vaultId = wikiHubPersonalId, owner = true) {
  const element = document.createElement("platformclaw-vault-document-actions") as Element;
  element.selected = wikiHubSnapshot({ selectedId: vaultId, owner }).selected!;
  const request = vi.fn();
  element.context = {
    client: { request } as unknown as VaultDocumentContext["client"],
    connected: true,
    agentId: "personal-a",
    methods: [
      "platformclaw.vault.document.get",
      "platformclaw.vault.document.delete",
      "platformclaw.vault.document.publish",
    ],
  };
  document.body.append(element);
  await element.updateComplete;
  return { element, request };
}
function button(element: HTMLElement, title: string) {
  const value = [...element.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === title,
  );
  expect(value, title).toBeDefined();
  return value!;
}

describe("selection of documents inside a vault", () => {
  it("selects loaded documents without opening them or changing a whole vault", async () => {
    const { element, request } = await mount();
    const opened = vi.fn();
    element.addEventListener("vault-document-open", opened);
    element.querySelector<HTMLInputElement>("[data-document-select]")!.click();
    await element.updateComplete;
    expect(element.textContent).toContain("Selected 1 of 2 loaded documents");
    expect(opened).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    button(element, "Select loaded documents").click();
    await element.updateComplete;
    expect(element.textContent).toContain("Selected 2 of 2 loaded documents");
    expect(
      [...element.querySelectorAll<HTMLInputElement>("[data-document-select]")].every(
        (input) => input.checked,
      ),
    ).toBe(true);
    button(element, "Clear selection").click();
    await element.updateComplete;
    expect(element.textContent).toContain("Selected 0 of 2 loaded documents");
  });
  it("never treats an unloaded catalog total as selected documents", async () => {
    const { element } = await mount();
    element.selected = { ...element.selected, documentsTruncated: true, documentCount: 3000 };
    await element.updateComplete;
    button(element, "Select loaded documents").click();
    await element.updateComplete;
    expect(element.querySelector("[data-vault-documents-truncated]")?.textContent).toContain(
      "3,000".replace(",", ""),
    );
    expect(element.textContent).toContain("Selected 2 of 2 loaded documents");
  });
  it("permits Personal publishing but does not offer cross-Shared publishing or Reader deletion", async () => {
    const personal = await mount();
    expect(button(personal.element, "Publish selected to Shared vault").disabled).toBe(true);
    const shared = await mount("vault-phy");
    expect(
      [...shared.element.querySelectorAll("button")].some(
        (item) => item.textContent?.trim() === "Publish selected to Shared vault",
      ),
    ).toBe(false);
    expect(button(shared.element, "Delete selected documents").disabled).toBe(true);
    const reader = await mount("vault-phy", false);
    expect(reader.element.querySelector("[data-document-select]")).toBeNull();
  });
  it("preserves selected IDs on refresh and drops vanished documents", async () => {
    const { element } = await mount();
    button(element, "Select loaded documents").click();
    await element.updateComplete;
    element.selected = { ...element.selected, documents: element.selected.documents.slice(1) };
    await element.updateComplete;
    expect(element.textContent).toContain("Selected 1 of 1 loaded documents");
    element.selected = wikiHubSnapshot({ selectedId: "vault-phy" }).selected!;
    await element.updateComplete;
    expect(element.textContent).toContain("Selected 0 of 2 loaded documents");
  });
  it("clears document selection on account/client changes and disables offline actions", async () => {
    const { element } = await mount();
    button(element, "Select loaded documents").click();
    await element.updateComplete;
    element.context = { ...element.context, agentId: "different-personal" };
    await element.updateComplete;
    expect(element.textContent).toContain("Selected 0 of 2 loaded documents");
    element.context = { ...element.context, connected: false };
    await element.updateComplete;
    expect(
      [...element.querySelectorAll<HTMLInputElement>("[data-document-select]")].every(
        (input) => input.disabled,
      ),
    ).toBe(true);
  });
  it("accepts a fresh same-path document even when it was recreated before the refresh", async () => {
    const { element } = await mount();
    const original = element.selected;
    button(element, "Select loaded documents").click();
    await element.updateComplete;
    button(element, "Delete selected documents").click();
    await element.updateComplete;
    const id = original.documents[0]!.id;
    element.querySelector("platformclaw-vault-document-bulk-delete")!.dispatchEvent(
      new CustomEvent("document-bulk-deleted", {
        bubbles: true,
        detail: {
          client: element.context.client,
          agentId: element.context.agentId,
          vaultId: original.vault.id,
          documentIds: [id],
        },
      }),
    );
    await element.updateComplete;
    expect(element.querySelector(`[data-document-select="${id}"]`)).toBeNull();
    element.selected = { ...original };
    await element.updateComplete;
    expect(element.querySelector<HTMLInputElement>(`[data-document-select="${id}"]`)?.checked).toBe(
      false,
    );
  });
  it("deselects only confirmed published source IDs while keeping unresolved documents selected", async () => {
    const { element } = await mount();
    button(element, "Select loaded documents").click();
    await element.updateComplete;
    button(element, "Publish selected to Shared vault").click();
    await element.updateComplete;
    const id = element.selected.documents[0]!.id;
    element.querySelector("platformclaw-vault-document-bulk-publish")!.dispatchEvent(
      new CustomEvent("document-publish-complete", {
        bubbles: true,
        detail: { vaultId: element.selected.vault.id, confirmedDocumentIds: [id] },
      }),
    );
    await element.updateComplete;
    expect(element.textContent).toContain("Selected 1 of 2 loaded documents");
    expect(element.querySelector<HTMLInputElement>(`[data-document-select="${id}"]`)?.checked).toBe(
      false,
    );
  });
});
