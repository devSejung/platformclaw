/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeVaultDocument } from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { deferred } from "../pages/config/memory-memories.test-support.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  button,
  document as vaultDocument,
  mount,
  rpc,
  setupVaultTests,
  snapshot,
} from "./memory-vaults.test-support.ts";

setupVaultTests();
let restoreDialog: () => void;
beforeEach(() => {
  restoreDialog = installDialogPolyfill();
});
afterEach(() => {
  document.body.replaceChildren();
  restoreDialog();
});

describe("Wiki reader modal lifecycle", () => {
  it.each(["loaded", "retried"] as const)(
    "keeps the modal and focused close action through a %s document read",
    async (outcome) => {
      const initial = deferred<KnowledgeVaultDocument>();
      const retry = deferred<KnowledgeVaultDocument>();
      let reads = 0;
      const request = vi.fn((method: string) =>
        method === `${rpc}document.get`
          ? ++reads === 1
            ? initial.promise
            : retry.promise
          : Promise.resolve(snapshot()),
      );
      const element = mount(request);
      await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
      const trigger = button(element, "Training");
      trigger.focus();
      trigger.click();
      await waitForFast(() =>
        expect(element.querySelector(".vaults__dialog [role=status]")).not.toBeNull(),
      );
      const reader = element.querySelector<HTMLElement>("platformclaw-vault-reader")!;
      const { modal, webAwesomeDialog, dialog } = await getRenderedModalDialog(reader);
      const show = vi.spyOn(dialog, "showModal");
      const statusClose = reader.querySelector<HTMLButtonElement>(".vaults__heading button")!;
      statusClose.focus();
      if (outcome === "retried") {
        initial.reject(new Error("Document read interrupted"));
        await waitForFast(() =>
          expect(reader.querySelector("[role=alert]")?.textContent).toContain(
            "Document read interrupted",
          ),
        );
        expect(reader.querySelector("openclaw-modal-dialog")).toBe(modal);
        expect(document.activeElement).toBe(statusClose);
        const retryButton = button(reader, "Retry");
        retryButton.focus();
        retryButton.click();
        await waitForFast(() =>
          expect(reader.querySelector(".vaults__dialog [role=status]")).not.toBeNull(),
        );
        expect(document.activeElement).toBe(statusClose);
        retry.resolve(vaultDocument);
      } else {
        initial.resolve(vaultDocument);
      }
      await waitForFast(() => expect(reader.querySelector("[data-vault-document]")).not.toBeNull());
      expect(reader.querySelector("openclaw-modal-dialog")).toBe(modal);
      expect(modal.shadowRoot?.querySelector("wa-dialog")).toBe(webAwesomeDialog);
      expect(webAwesomeDialog.shadowRoot?.querySelector("dialog")).toBe(dialog);
      expect(dialog.open).toBe(true);
      expect(show).not.toHaveBeenCalled();
      const close = reader.querySelector<HTMLButtonElement>(
        ".wiki-document__actions button:last-child",
      )!;
      expect(document.activeElement).toBe(close);
      expect(button(reader, "Download Markdown").disabled).toBe(false);
      close.click();
      await waitForFast(() =>
        expect(element.querySelector("platformclaw-vault-reader")).toBeNull(),
      );
      expect(document.activeElement).toBe(trigger);
    },
  );

  it.each(["button", "native"] as const)(
    "keeps the reader open when %s dismissal cancels deletion",
    async (source) => {
      const element = mount(
        vi.fn(async (method: string) =>
          method === `${rpc}document.get` ? vaultDocument : snapshot(),
        ),
      );
      await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
      button(element, "Training").click();
      await waitForFast(() =>
        expect(element.querySelector("[data-vault-document]")).not.toBeNull(),
      );
      const reader = element.querySelector<HTMLElement>("platformclaw-vault-reader")!;
      const { modal, webAwesomeDialog, dialog } = await getRenderedModalDialog(reader);
      const deleteButton = button(reader, "Delete document");
      deleteButton.focus();
      deleteButton.click();
      await waitForFast(() => expect(reader.querySelector(".vaults__dialog")).not.toBeNull());
      expect(reader.querySelector("openclaw-modal-dialog")).toBe(modal);
      expect(document.activeElement).toBe(reader.querySelector(".vaults__heading button"));
      if (source === "button") {
        const cancel = button(reader, "Cancel");
        cancel.focus();
        cancel.click();
      } else {
        const onCancel = vi.fn<(event: Event) => void>();
        modal.addEventListener("modal-cancel", onCancel, { once: true });
        const hide = new Event("wa-hide", { cancelable: true });
        webAwesomeDialog.dispatchEvent(hide);
        expect(onCancel).toHaveBeenCalledOnce();
        expect(onCancel.mock.calls[0]?.[0].defaultPrevented).toBe(true);
        expect(hide.defaultPrevented).toBe(true);
      }
      await waitForFast(() => expect(reader.querySelector("[data-vault-document]")).not.toBeNull());
      expect(reader.querySelector("openclaw-modal-dialog")).toBe(modal);
      expect(dialog.open).toBe(true);
      expect(document.activeElement).toBe(
        reader.querySelector(".wiki-document__actions button:last-child"),
      );
    },
  );

  it("does not recreate a reader closed before its initial document read settles", async () => {
    const pending = deferred<KnowledgeVaultDocument>();
    const request = vi.fn((method: string) =>
      method === `${rpc}document.get` ? pending.promise : Promise.resolve(snapshot()),
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    const trigger = button(element, "Training");
    trigger.focus();
    trigger.click();
    await waitForFast(() =>
      expect(element.querySelector("platformclaw-vault-reader")).not.toBeNull(),
    );
    const reader = element.querySelector<HTMLElement>("platformclaw-vault-reader")!;
    const { modal } = await getRenderedModalDialog(reader);
    button(reader, "Close dialog").click();
    await waitForFast(() => expect(element.querySelector("platformclaw-vault-reader")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    pending.resolve(vaultDocument);
    await pending.promise;
    await element.updateComplete;
    expect(element.querySelector("platformclaw-vault-reader")).toBeNull();
    expect(modal.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});
