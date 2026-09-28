/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../pages/config/memory-memories.test-support.ts";
import {
  wikiHubPersonalDocument,
  wikiHubPersonalId,
  wikiHubSharedDocument,
  wikiHubSnapshot,
} from "../test-helpers/platformclaw-wiki-hub-fixture.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  button,
  fill,
  mount,
  rpc,
  setupVaultTests,
  snapshot,
  submit,
} from "./memory-vaults.test-support.ts";

setupVaultTests();
describe("Wiki draft lifecycle", () => {
  it.each([
    { personal: false, editing: false },
    { personal: false, editing: true },
    { personal: true, editing: false },
    { personal: true, editing: true },
  ])(
    "preserves $personal/$editing drafts across transport loss but clears a changed identity",
    async ({ personal, editing }) => {
      const vaultId = personal ? wikiHubPersonalId : "vault-phy";
      const doc = personal ? wikiHubPersonalDocument : wikiHubSharedDocument;
      const request = vi.fn(async (method: string) => {
        if (method === rpc + "document.get") {
          return doc;
        }
        if (method === rpc + "document.preview") {
          return { title: "My unsaved title", logicalPath: doc.logicalPath };
        }
        if (method === rpc + "document.save") {
          throw new Error("Revision conflict: reload before saving");
        }
        return wikiHubSnapshot({ selectedId: vaultId });
      });
      const element = mount(request);
      await waitForFast(() => expect(element.querySelector(".vaults__selected")).not.toBeNull());
      if (editing) {
        button(element, doc.title).click();
        await waitForFast(() =>
          expect(element.querySelector("[data-vault-document]")).not.toBeNull(),
        );
        button(element, "Edit document").click();
      } else {
        button(element, "Add knowledge").click();
      }
      await waitForFast(() => expect(element.querySelector("[data-vault-editor]")).not.toBeNull());
      fill(element, "title", "My unsaved title");
      fill(element, "content", "My unsaved body");
      const author = element.querySelector("platformclaw-vault-author");
      element.connected = false;
      await waitForFast(() =>
        expect(
          element.querySelector<HTMLButtonElement>("[data-vault-editor] button.primary")?.disabled,
        ).toBe(true),
      );
      expect(element.querySelector("platformclaw-vault-author")).toBe(author);
      expect(author?.querySelector('[role="status"]')?.textContent).toMatch(/offline/i);
      expect(element.querySelector<HTMLInputElement>("[name=title]")?.value).toBe(
        "My unsaved title",
      );
      expect(element.querySelector<HTMLTextAreaElement>("[name=content]")?.value).toBe(
        "My unsaved body",
      );
      const count = request.mock.calls.length;
      submit(element.querySelector<HTMLFormElement>("[data-vault-editor]")!);
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(count);
      element.connected = true;
      await waitForFast(() =>
        expect(
          element.querySelector<HTMLButtonElement>("[data-vault-editor] button.primary")?.disabled,
        ).toBe(false),
      );
      expect(element.querySelector("platformclaw-vault-author")).toBe(author);
      expect(element.querySelector<HTMLInputElement>("[name=title]")?.value).toBe(
        "My unsaved title",
      );
      submit(element.querySelector<HTMLFormElement>("[data-vault-editor]")!);
      await waitForFast(() => expect(element.textContent).toContain("Save document"));
      submit(element.querySelector<HTMLFormElement>("[data-vault-editor]")!);
      await waitForFast(() => expect(element.textContent).toContain("Revision conflict"));
      expect(request).toHaveBeenCalledWith(
        rpc + "document.save",
        expect.objectContaining({
          vaultId,
          title: "My unsaved title",
          content: "My unsaved body",
          ...(editing ? { expectedRevision: doc.revision, documentId: doc.id } : {}),
        }),
      );
      element.agentId = "different-agent";
      await waitForFast(() =>
        expect(element.querySelector("platformclaw-vault-author")).toBeNull(),
      );
    },
  );

  it("blocks publication during replacement selection and hashing, including direct submit", async () => {
    const request = vi.fn(async (method: string) =>
      method === rpc + "document.preview"
        ? { title: "Original", logicalPath: "original.md" }
        : snapshot(),
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Add knowledge").click();
    await waitForFast(() =>
      expect(element.querySelector("#vault-author-source-tab-personal")).not.toBeNull(),
    );
    element
      .querySelector("#vault-author-source-tab-personal")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    const select = (title: string, complete = true) =>
      element.querySelector("openclaw-memory-promotion-source-picker")!.dispatchEvent(
        new CustomEvent("source-selected", {
          bubbles: true,
          detail: {
            title,
            lookup: title + ".md",
            path: title + ".md",
            content: title,
            ...(complete ? { sourceContent: title } : {}),
          },
        }),
      );
    await waitForFast(() =>
      expect(element.querySelector("openclaw-memory-promotion-source-picker")).not.toBeNull(),
    );
    select("Original");
    await waitForFast(() => expect(element.querySelector("[data-vault-editor]")).not.toBeNull());
    submit(element.querySelector<HTMLFormElement>("[data-vault-editor]")!);
    await waitForFast(() => expect(element.textContent).toContain("Publish shared copy"));
    button(element, "Choose another Personal document").click();
    await waitForFast(() =>
      expect(element.querySelector("openclaw-memory-promotion-source-picker")).not.toBeNull(),
    );
    const blocked = async () => {
      expect(
        element.querySelector<HTMLButtonElement>("[data-vault-editor] button.primary")?.disabled,
      ).toBe(true);
      const count = request.mock.calls.length;
      submit(element.querySelector<HTMLFormElement>("[data-vault-editor]")!);
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(count);
    };
    await blocked();
    button(element, "Keep editing").click();
    await waitForFast(() =>
      expect(
        element.querySelector<HTMLButtonElement>("[data-vault-editor] button.primary")?.disabled,
      ).toBe(false),
    );
    button(element, "Choose another Personal document").click();
    await waitForFast(() =>
      expect(element.querySelector("openclaw-memory-promotion-source-picker")).not.toBeNull(),
    );
    select("Incomplete", false);
    await waitForFast(() => expect(element.querySelector('[role="alert"]')).not.toBeNull());
    await blocked();
    expect(element.querySelector(".vaults__author-preview")?.textContent).toContain("Original");
    button(element, "Keep editing").click();
    await waitForFast(() =>
      expect(
        element.querySelector<HTMLButtonElement>("[data-vault-editor] button.primary")?.disabled,
      ).toBe(false),
    );
    expect(element.querySelector(".vaults__author-preview")?.textContent).toContain("Original");
    button(element, "Choose another Personal document").click();
    await waitForFast(() =>
      expect(element.querySelector("openclaw-memory-promotion-source-picker")).not.toBeNull(),
    );
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("Digest failed"));
    select("Hash failure");
    await waitForFast(() => expect(element.textContent).toContain("Digest failed"));
    await blocked();
    button(element, "Keep editing").click();
    await waitForFast(() =>
      expect(
        element.querySelector<HTMLButtonElement>("[data-vault-editor] button.primary")?.disabled,
      ).toBe(false),
    );
    expect(element.querySelector<HTMLInputElement>("[name=title]")?.value).toBe("Original");
    expect(element.querySelector(".vaults__author-preview")?.textContent).toContain("Original");
    button(element, "Choose another Personal document").click();
    await waitForFast(() =>
      expect(element.querySelector("openclaw-memory-promotion-source-picker")).not.toBeNull(),
    );
    const first = deferred<ArrayBuffer>();
    const second = deferred<ArrayBuffer>();
    digest.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    select("Replacement");
    await element.updateComplete;
    await blocked();
    select("Newest");
    second.resolve(new Uint8Array([2]).buffer);
    await waitForFast(() =>
      expect(element.querySelector<HTMLInputElement>("[name=title]")?.value).toBe("Newest"),
    );
    first.resolve(new Uint8Array([1]).buffer);
    await Promise.resolve();
    await element.updateComplete;
    expect(element.querySelector<HTMLInputElement>("[name=title]")?.value).toBe("Newest");
    expect(request.mock.calls.some(([method]) => method === rpc + "publish")).toBe(false);
  });
});
