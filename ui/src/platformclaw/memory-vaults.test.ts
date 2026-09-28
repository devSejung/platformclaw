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
  (form.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value;
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
    expect(element.textContent).toContain("Existing vaults are never merged");
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
    ).toContain("vault-1 · doc-1 · training.md · r3");
    expect(button(element, "Download Markdown")).toBeDefined();
    expect(request).toHaveBeenLastCalledWith(`${rpc}document.get`, {
      vaultId: "vault-1",
      documentId: "doc-1",
    });
  });
  it("saves exact original bytes with revision, retaining edits when save conflicts", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === `${rpc}document.get`) {
        return document;
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
    await element.updateComplete;
    const form = element.querySelector("[data-vault-editor]") as HTMLFormElement;
    const original = "# Authored\n\n  Keep trailing spaces.  \n";
    fill(form, "content", original);
    fill(form, "path", "guides/moved.md");
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
    expect(element.querySelector<HTMLTextAreaElement>("[name=content]")?.value).toBe(original);
  });
  it.each(["upload", "edit"] as const)(
    "preserves unchanged UTF-8 BOM and CRLF through %s",
    async (mode) => {
      const content = "\uFEFF# Original\r\n\r\n  Keep spaces.  \r\n";
      const request = vi.fn(async (method: string) =>
        method === `${rpc}document.get` ? { ...document, content } : snapshot(),
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
        const file = new File([], "original.md", { type: "text/markdown" });
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
      expect(element.querySelector<HTMLTextAreaElement>("[name=content]")?.value).toBe(
        content.replaceAll("\r\n", "\n"),
      );
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

  it("publishes only after source review and explicit confirmation with the full source hash", async () => {
    const request = vi.fn(async (method: string) =>
      method === "wiki.document.get"
        ? {
            title: "Private training",
            sourceContent: "# Private\nOriginal",
            revision: "sha-private",
          }
        : snapshot(),
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Publish Personal Wiki copy").click();
    await element.updateComplete;
    const sourceInput = element.querySelector<HTMLInputElement>("[name=lookup]")!;
    sourceInput.value = "concepts/training.md";
    submit(sourceInput.closest("form")!);
    await waitForFast(() =>
      expect(element.querySelector(".vaults__source")?.textContent).toBe("# Private\nOriginal"),
    );
    expect(request.mock.calls.some(([method]) => method === `${rpc}publish`)).toBe(false);
    const confirm = button(element, "Publish reviewed copy to this Shared vault");
    submit(confirm.closest("form")!);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}publish`, {
        lookup: "concepts/training.md",
        targetVaultId: "vault-1",
        path: "concepts/training.md",
        expectedRevision: createHash("sha256").update("# Private\nOriginal").digest("hex"),
      }),
    );
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
