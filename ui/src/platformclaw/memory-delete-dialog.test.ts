/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./memory-delete-dialog.ts";

type DeleteDialog = HTMLElement & {
  client: GatewayBrowserClient | null;
  agentId: string;
  path: string;
  updateComplete: Promise<unknown>;
};

function createDialog(request: ReturnType<typeof vi.fn>) {
  const element = document.createElement("platformclaw-memory-delete-dialog") as DeleteDialog;
  element.client = { request } as unknown as GatewayBrowserClient;
  element.agentId = "personal-agent";
  element.path = "memory/runbook.md";
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
  it("shows a fresh preview and sends its hash only after explicit deletion", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ deleted: true, indexesRefreshed: true });
    const element = createDialog(request);
    const deleted = vi.fn();
    element.addEventListener("memory-deleted", deleted);
    await waitForFast(() =>
      expect(element.querySelector("pre")?.textContent).toBe("Current memory"),
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
    await waitForFast(() => expect(element.querySelector("pre")?.textContent).toBe("New memory"));
    resolveOld?.(preview("Old memory", "old-hash"));
    await Promise.resolve();
    await element.updateComplete;
    expect(element.querySelector("pre")?.textContent).toBe("New memory");
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
    await waitForFast(() => expect(element.querySelector("pre")).not.toBeNull());
    element.querySelector<HTMLButtonElement>("button.danger")!.click();
    element.remove();
    resolveDelete?.({ deleted: true, indexesRefreshed: true });
    await Promise.resolve();
    expect(deleted).not.toHaveBeenCalled();
  });

  it("does not delete with a preview from an identity changed before the next render", async () => {
    const request = vi.fn().mockResolvedValue(preview());
    const element = createDialog(request);
    await waitForFast(() => expect(element.querySelector("pre")).not.toBeNull());
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
    await waitForFast(() => expect(element.querySelector("pre")).not.toBeNull());
    element.querySelector<HTMLButtonElement>("button.danger")!.click();
    element.agentId = "new-agent";
    await waitForFast(() => expect(element.querySelector("pre")?.textContent).toBe("New memory"));
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
    await waitForFast(() => expect(element.querySelector("pre")).not.toBeNull());
    element.querySelector<HTMLButtonElement>("button.danger")!.click();
    await waitForFast(() =>
      expect(element.querySelector("[role=alert]")?.textContent).toContain("Memory changed"),
    );
    expect(deleted).not.toHaveBeenCalled();
    expect(element.querySelector<HTMLButtonElement>("button.danger")?.disabled).toBe(false);
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
