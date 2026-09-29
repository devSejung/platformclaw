/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
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

function requestUrl(input: string | URL | Request) {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

describe("Wiki Hub vault lifecycle management", () => {
  it("lets an Owner rename and explicitly confirm deletion of a Shared vault", async () => {
    let current = snapshot();
    const request = vi.fn(async (method: string, params?: { name?: string; vaultId?: string }) => {
      if (method === `${rpc}rename`) {
        const name = params?.name ?? "";
        current = {
          ...current,
          vaults: current.vaults.map((vault) =>
            vault.id === "vault-1" ? { ...vault, name } : vault,
          ),
          selected: current.selected
            ? { ...current.selected, vault: { ...current.selected.vault, name } }
            : undefined,
        };
        return current.selected!.vault;
      }
      if (method === `${rpc}delete`) {
        current = { ...current, vaults: [], selected: undefined };
        return { deleted: true, vaultId: "vault-1" };
      }
      return current;
    });
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));

    button(element, "Rename vault").click();
    await waitForFast(() =>
      expect(element.querySelector('openclaw-modal-dialog input[name="name"]')).not.toBeNull(),
    );
    const renameForm = element
      .querySelector('openclaw-modal-dialog input[name="name"]')!
      .closest("form")!;
    fill(renameForm, "name", "PHY Reference");
    submit(renameForm);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}rename`, {
        vaultId: "vault-1",
        name: "PHY Reference",
      }),
    );
    await waitForFast(() => expect(element.textContent).toContain("PHY Reference"));

    button(element, "Delete vault").click();
    await waitForFast(() => expect(element.textContent).toContain("Delete vault permanently"));
    expect(request.mock.calls.some(([method]) => method === `${rpc}delete`)).toBe(false);
    button(element, "Delete vault permanently").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}delete`, { vaultId: "vault-1" }),
    );
    await waitForFast(() => expect(element.textContent).toContain("Vault deleted"));
    expect(element.querySelector(".vaults__selected")).toBeNull();
  });

  it("replaces and deletes attachments with the snapshot revision without exposing raw revisions", async () => {
    let current = snapshot();
    current.selected!.attachments = [
      {
        path: "captures/training-result.pdf",
        mediaType: "application/pdf",
        bytes: 2048,
        revision: 2,
      },
      {
        path: "archive/training-result.pdf",
        mediaType: "application/pdf",
        bytes: 1024,
        revision: 4,
      },
    ];
    const request = vi.fn().mockImplementation(async () => current);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        current = {
          ...current,
          selected: current.selected ? { ...current.selected, attachments: [] } : undefined,
        };
        return new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("captures/training-result.pdf"));
    expect(element.textContent).toContain("archive/training-result.pdf");
    expect(element.textContent).toContain("2 KB");
    expect(element.textContent).not.toContain("r2");

    const replacement = new File(["replacement"], "new-name.pdf", {
      type: "application/pdf",
    });
    const replaceInput = [...element.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(
      (input) => input.closest("label")?.textContent?.trim() === "Replace",
    )!;
    Object.defineProperty(replaceInput, "files", { value: [replacement] });
    replaceInput.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "vaultId=vault-1&path=captures%2Ftraining-result.pdf&expectedRevision=2",
        ),
        expect.objectContaining({ method: "PUT", body: replacement }),
      ),
    );
    await waitForFast(() => expect(button(element, "Delete").disabled).toBe(false));

    button(element, "Delete").click();
    await waitForFast(() => expect(element.textContent).toContain("Delete attachment"));
    expect(element.querySelector("openclaw-modal-dialog")?.getAttribute("label")).toBe(
      "Delete attachment",
    );
    expect(element.textContent).toContain("Permanently delete this attachment");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    button(element, "Delete attachment").click();
    await waitForFast(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            init?.method === "DELETE" &&
            requestUrl(input).includes(
              "vaultId=vault-1&path=captures%2Ftraining-result.pdf&expectedRevision=2",
            ),
        ),
      ).toBe(true),
    );
    await waitForFast(() => expect(element.textContent).toContain("Attachment deleted"));
    expect(element.textContent).not.toContain("training-result.pdf");
  });
});
