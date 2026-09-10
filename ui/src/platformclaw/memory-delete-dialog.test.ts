/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import "./memory-delete-dialog.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { loadPlatformClawLocale } from "./i18n.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});

type DeleteDialog = HTMLElement & {
  client: GatewayBrowserClient | null;
  agentId: string;
  path: string;
  kind: "memory" | "wiki";
  updateComplete: Promise<unknown>;
};

function createDialog(request: ReturnType<typeof vi.fn>, kind: "memory" | "wiki" = "memory") {
  const element = document.createElement("platformclaw-memory-delete-dialog") as DeleteDialog;
  element.client = { request } as unknown as GatewayBrowserClient;
  element.agentId = "personal-agent";
  element.path = "memory/runbook.md";
  element.kind = kind;
  document.body.append(element);
  return element;
}

const preview = (content = "Current memory", contentHash = "current-hash") => ({
  file: { content, contentHash, encoding: "utf8" },
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("memory deletion confirmation", () => {
  it.each([
    ["shared-vault", "Shared-vault pages"],
    ["page-too-large", "256 KiB"],
    ["generated-page", "generated report or navigation page"],
  ])(
    "explains why a Wiki page cannot be deleted: %s",
    async (deletionUnavailableReason, message) => {
      const request = vi
        .fn()
        .mockResolvedValue({ path: "page.md", content: "Page", deletionUnavailableReason });
      const element = createDialog(request, "wiki");
      await waitForFast(() =>
        expect(element.querySelector("[role=alert]")?.textContent).toContain(message),
      );
      expect(element.querySelector<HTMLButtonElement>("button.danger")?.disabled).toBe(true);
    },
  );
  it.each([false, true])(
    "deletes the resolved Wiki page with its full-file hash (partial preview: %s)",
    async (truncated) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          path: "concepts/runbook.md",
          content: "Wiki body",
          contentHash: "raw-file-hash",
          truncated,
        })
        .mockResolvedValueOnce({ deleted: true, indexesRefreshed: true });
      const element = createDialog(request, "wiki");
      const deleted = vi.fn();
      element.addEventListener("memory-deleted", deleted);
      await waitForFast(() =>
        expect(element.querySelector(".wiki-document__reader")?.textContent?.trim()).toBe(
          "Wiki body",
        ),
      );
      if (truncated) {
        expect(element.textContent).toContain("Only part of the page is shown");
      }
      expect(request).toHaveBeenCalledExactlyOnceWith("wiki.get", {
        agentId: "personal-agent",
        lookup: "memory/runbook.md",
        fromLine: 1,
        lineCount: 5000,
      });
      element.querySelector<HTMLButtonElement>("button.danger")!.click();
      await waitForFast(() => expect(deleted).toHaveBeenCalledOnce());
      expect(request).toHaveBeenLastCalledWith("wiki.delete", {
        agentId: "personal-agent",
        path: "concepts/runbook.md",
        expectedContentHash: "raw-file-hash",
      });
      expect(request.mock.calls.some(([method]) => method === "memory.delete")).toBe(false);
    },
  );

  it("invalidates a memory preview immediately when its target changes to Wiki", async () => {
    const request = vi.fn().mockResolvedValue(preview());
    const element = createDialog(request);
    await waitForFast(() => expect(element.querySelector(".wiki-document__reader")).not.toBeNull());
    element.kind = "wiki";
    element.querySelector<HTMLButtonElement>("button.danger")!.click();
    expect(request.mock.calls.some(([method]) => method.endsWith(".delete"))).toBe(false);
    await element.updateComplete;
  });

  it.each([null, { path: "concepts/page.md", content: "No verifiable raw hash" }])(
    "does not delete an unverifiable Wiki preview",
    async (result) => {
      const request = vi.fn().mockResolvedValue(result);
      const element = createDialog(request, "wiki");
      await waitForFast(() => expect(element.querySelector("[role=alert]")).not.toBeNull());
      expect(element.querySelector<HTMLButtonElement>("button.danger")?.disabled).toBe(true);
    },
  );
  it("shows a fresh preview and sends its hash only after explicit deletion", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ deleted: true, indexesRefreshed: true });
    const element = createDialog(request);
    const deleted = vi.fn();
    element.addEventListener("memory-deleted", deleted);
    await waitForFast(() =>
      expect(element.querySelector(".wiki-document__reader")?.textContent?.trim()).toBe(
        "Current memory",
      ),
    );
    expect(request).toHaveBeenCalledExactlyOnceWith("agents.workspace.get", {
      agentId: "personal-agent",
      path: "memory/runbook.md",
    });
    expect(deleted).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>("button.danger")!.click();
    await waitForFast(() => expect(deleted).toHaveBeenCalledOnce());
    expect(request).toHaveBeenLastCalledWith("memory.delete", {
      agentId: "personal-agent",
      path: "memory/runbook.md",
      expectedContentHash: "current-hash",
    });
  });

  it("ignores preview responses from a previous identity", async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(preview("New memory", "new-hash"));
    const element = createDialog(request);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    element.agentId = "new-agent";
    await waitForFast(() =>
      expect(element.querySelector(".wiki-document__reader")?.textContent?.trim()).toBe(
        "New memory",
      ),
    );
    resolveOld?.(preview("Old memory", "old-hash"));
    await Promise.resolve();
    await element.updateComplete;
    expect(element.querySelector(".wiki-document__reader")?.textContent?.trim()).toBe("New memory");
    expect(request).toHaveBeenLastCalledWith("agents.workspace.get", {
      agentId: "new-agent",
      path: "memory/runbook.md",
    });
  });

  it("does not report completion after the dialog is disconnected", async () => {
    let resolveDelete: ((value: unknown) => void) | undefined;
    const request = vi
      .fn()
      .mockResolvedValueOnce(preview())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDelete = resolve;
          }),
      );
    const element = createDialog(request);
    const deleted = vi.fn();
    element.addEventListener("memory-deleted", deleted);
    await waitForFast(() => expect(element.querySelector(".wiki-document__reader")).not.toBeNull());
    element.querySelector<HTMLButtonElement>("button.danger")!.click();
    element.remove();
    resolveDelete?.({ deleted: true, indexesRefreshed: true });
    await Promise.resolve();
    expect(deleted).not.toHaveBeenCalled();
  });

  it("does not delete with a preview from an identity changed before the next render", async () => {
    const request = vi.fn().mockResolvedValue(preview());
    const element = createDialog(request);
    await waitForFast(() => expect(element.querySelector(".wiki-document__reader")).not.toBeNull());
    element.agentId = "new-agent";
    element.querySelector<HTMLButtonElement>("button.danger")!.click();
    expect(request.mock.calls.some(([method]) => method === "memory.delete")).toBe(false);
    await element.updateComplete;
  });

  it("unblocks a new identity and ignores the previous pending deletion", async () => {
    let resolveDelete: ((value: unknown) => void) | undefined;
    const request = vi
      .fn()
      .mockResolvedValueOnce(preview())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDelete = resolve;
          }),
      )
      .mockResolvedValueOnce(preview("New memory", "new-hash"));
    const element = createDialog(request);
    const deleted = vi.fn();
    element.addEventListener("memory-deleted", deleted);
    await waitForFast(() => expect(element.querySelector(".wiki-document__reader")).not.toBeNull());
    element.querySelector<HTMLButtonElement>("button.danger")!.click();
    element.agentId = "new-agent";
    await waitForFast(() =>
      expect(element.querySelector(".wiki-document__reader")?.textContent?.trim()).toBe(
        "New memory",
      ),
    );
    expect(element.querySelector<HTMLButtonElement>("button.danger")?.disabled).toBe(false);
    resolveDelete?.({ deleted: true, indexesRefreshed: true });
    await Promise.resolve();
    expect(deleted).not.toHaveBeenCalled();
  });

  it("shows a deletion failure and keeps the dialog available", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(preview())
      .mockRejectedValueOnce(new Error("Memory changed. Refresh the preview."));
    const element = createDialog(request);
    const deleted = vi.fn();
    element.addEventListener("memory-deleted", deleted);
    await waitForFast(() => expect(element.querySelector(".wiki-document__reader")).not.toBeNull());
    element.querySelector<HTMLButtonElement>("button.danger")!.click();
    await waitForFast(() =>
      expect(element.querySelector("[role=alert]")?.textContent).toContain("Memory changed"),
    );
    expect(deleted).not.toHaveBeenCalled();
    expect(element.querySelector<HTMLButtonElement>("button.danger")?.disabled).toBe(false);
  });

  it("keeps the dialog open while deletion is pending", async () => {
    let rejectDelete!: (error: Error) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce(preview())
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectDelete = reject;
          }),
      );
    const element = createDialog(request);
    await waitForFast(() => expect(element.querySelector("pre")).not.toBeNull());
    element.querySelector<HTMLButtonElement>("button.danger")!.click();
    await element.updateComplete;
    const modal = element.querySelector("openclaw-modal-dialog")!;
    const cancel = new CustomEvent("modal-cancel", { cancelable: true });
    modal.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(element.querySelector("openclaw-modal-dialog")).not.toBeNull();
    rejectDelete(new Error("Memory changed. Refresh the preview."));
    await waitForFast(() =>
      expect(element.querySelector("[role=alert]")?.textContent).toContain("Memory changed"),
    );
    const retryCancel = new CustomEvent("modal-cancel", { cancelable: true });
    modal.dispatchEvent(retryCancel);
    expect(retryCancel.defaultPrevented).toBe(false);
  });

  it.each([
    { file: { content: "", encoding: "utf8", missing: true } },
    { file: { content: "bytes", encoding: "base64", contentHash: "hash" } },
    { file: { content: "No hash", encoding: "utf8" } },
  ])("disables deletion when a verifiable text preview is unavailable", async (result) => {
    const request = vi.fn().mockResolvedValue(result);
    const element = createDialog(request);
    await waitForFast(() => expect(element.querySelector("[role=alert]")).not.toBeNull());
    expect(element.querySelector<HTMLButtonElement>("button.danger")?.disabled).toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });
});
