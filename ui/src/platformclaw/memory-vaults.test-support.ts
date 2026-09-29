import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type {
  KnowledgeVaultDocument,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
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
export const rpc = "platformclaw.vault.";
export const document: KnowledgeVaultDocument = {
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
export function snapshot(owner = true): KnowledgeVaultSnapshot {
  const vault = {
    id: "vault-1",
    name: "PHY Spec",
    description: "Hardware notes",
    type: "shared" as const,
    role: owner ? ("owner" as const) : ("reader" as const),
    canRead: true,
    canEdit: owner,
    canManageMembers: owner,
    canExport: owner,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    ownRequests: [],
    pendingRequests: [],
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
        },
      ],
      grants: [],
      attachments: [],
    },
  };
}
export function mount(request: ReturnType<typeof vi.fn>) {
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
      `${rpc}document.delete`,
      `${rpc}document.preview`,
      `${rpc}publish`,
    ],
  });
  globalThis.document.body.append(element);
  return element;
}
export function button(element: HTMLElement, text: string) {
  const value = [...element.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text,
  );
  expect(value, text).toBeDefined();
  return value!;
}
export function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
export function fill(form: Element, name: string, value: string) {
  const input = form.querySelector(`[name="${name}"]`) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
export function setupVaultTests() {
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
}
