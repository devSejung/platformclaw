/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeVault,
  KnowledgeVaultDocument,
  KnowledgeVaultDocumentSummary,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { GatewayBrowserClient, GatewayRequestError } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { loadPlatformClawLocale, platformClawT } from "./i18n.ts";
import type {
  VaultDocumentBulkDeleteResult,
  VaultDocumentsBulkDeleted,
} from "./memory-vault-document-bulk-delete.ts";
import "./memory-vault-document-bulk-delete.ts";

const RPC = "platformclaw.vault.document.";
type BulkElement = HTMLElement & {
  client: GatewayBrowserClient;
  connected: boolean;
  agentId: string | null;
  vault: KnowledgeVault;
  documents: readonly KnowledgeVaultDocumentSummary[];
  updateComplete: Promise<unknown>;
};
type RequestParams = { vaultId: string; documentId: string; expectedRevision?: string | number };

beforeEach(async () => {
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function vault(overrides: Partial<KnowledgeVault> = {}): KnowledgeVault {
  return {
    id: "shared-one",
    name: "Synthetic Wiki",
    type: "shared",
    description: "Synthetic test documents",
    role: "editor",
    canRead: true,
    canEdit: true,
    canManageMembers: false,
    canExport: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function fullDocument(
  id: string,
  overrides: Partial<KnowledgeVaultDocument> = {},
): KnowledgeVaultDocument {
  return {
    id,
    vaultId: "shared-one",
    title: `Document ${id}`,
    logicalPath: `concepts/${id}.md`,
    revision: 5,
    updatedAt: 1,
    compile: { status: "ready", indexedRevision: 5, error: null, attempts: 0, retryAt: null },
    content: `# Document ${id}\n\nSynthetic full document.`,
    links: [],
    backlinks: [],
    ...overrides,
  };
}

function summary(
  id: string,
  overrides: Partial<KnowledgeVaultDocumentSummary> = {},
): KnowledgeVaultDocumentSummary {
  const { content: _content, links: _links, backlinks: _backlinks, ...value } = fullDocument(id);
  return {
    ...value,
    title: `Old ${id}`,
    revision: 1,
    snippet: "Stale graph preview",
    ...overrides,
  };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function requestWithDelete(
  deleteRequest: (params: RequestParams) => unknown = (params) => ({
    deleted: true,
    documentId: params.documentId,
  }),
) {
  return vi.fn(async (method: string, params: RequestParams) =>
    method === `${RPC}get` ? fullDocument(params.documentId) : deleteRequest(params),
  );
}

async function mount(
  request: ReturnType<typeof vi.fn>,
  documents = [summary("one"), summary("two")],
  selectedVault = vault(),
) {
  const element = document.createElement("platformclaw-vault-document-bulk-delete") as BulkElement;
  Object.assign(element, {
    client: { request },
    connected: true,
    agentId: "agent-a",
    vault: selectedVault,
    documents,
  });
  const results: VaultDocumentBulkDeleteResult[] = [];
  const deleted: VaultDocumentsBulkDeleted[] = [];
  const busy: boolean[] = [];
  const close = vi.fn();
  element.addEventListener("document-bulk-delete-result", (event) =>
    results.push((event as CustomEvent<VaultDocumentBulkDeleteResult>).detail),
  );
  element.addEventListener("document-bulk-deleted", (event) =>
    deleted.push((event as CustomEvent<VaultDocumentsBulkDeleted>).detail),
  );
  element.addEventListener("document-bulk-busy", (event) =>
    busy.push((event as CustomEvent<boolean>).detail),
  );
  element.addEventListener("document-bulk-close", close);
  document.body.append(element);
  await element.updateComplete;
  return { element, results, deleted, busy, close };
}

function button(element: HTMLElement, key: string) {
  const text = platformClawT(`platformClaw.vault.${key}`);
  const match = [...element.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text || item.getAttribute("aria-label") === text,
  );
  expect(match, text).toBeDefined();
  return match!;
}
async function ready(element: HTMLElement) {
  await waitForFast(() => expect(element.querySelector("button.danger")).not.toBeNull());
}
function confirm(element: HTMLElement) {
  const control = element.querySelector<HTMLButtonElement>("button.danger");
  expect(control).not.toBeNull();
  control!.click();
  return control!;
}
function deletes(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls.filter(([method]) => method === `${RPC}delete`);
}

describe("selected Wiki document bulk deletion", () => {
  it("loads full documents, freezes the selection, and pins fresh revisions after explicit confirmation", async () => {
    const one = summary("one");
    const request = requestWithDelete();
    const { element, results, deleted } = await mount(request, [
      one,
      summary("two"),
      summary("two"),
    ]);
    await ready(element);
    expect(deletes(request)).toEqual([]);
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      [`${RPC}get`, { vaultId: "shared-one", documentId: "one" }],
      [`${RPC}get`, { vaultId: "shared-one", documentId: "two" }],
    ]);
    expect(request).toHaveBeenCalledWith(`${RPC}get`, expect.any(Object), {
      timeoutMs: 30_000,
      signal: expect.any(AbortSignal),
    });
    expect(element.textContent).toContain("Document one");
    expect(element.textContent).toContain("Document two");
    expect(element.textContent).not.toContain("Stale graph preview");
    expect(element.textContent).toContain(
      platformClawT("platformClaw.vault.documentBulkDeleteHint", { count: "2" }),
    );
    one.id = "replacement";
    one.title = "Changed outside the dialog";
    element.documents = [summary("three")];
    await element.updateComplete;
    element.addEventListener("document-bulk-deleted", () => {
      element.documents = [];
    });
    confirm(element);
    await waitForFast(() => expect(results).toHaveLength(1));
    expect(deletes(request)).toEqual([
      [
        `${RPC}delete`,
        { vaultId: "shared-one", documentId: "one", expectedRevision: 5 },
        { timeoutMs: 30_000 },
      ],
      [
        `${RPC}delete`,
        { vaultId: "shared-one", documentId: "two", expectedRevision: 5 },
        { timeoutMs: 30_000 },
      ],
    ]);
    expect(results[0]!.items.map((item) => [item.documentId, item.status])).toEqual([
      ["one", "deleted"],
      ["two", "deleted"],
    ]);
    expect(deleted.map((event) => event.documentIds)).toEqual([["one"], ["two"]]);
    expect(request.mock.calls.every(([method]) => method.startsWith(RPC))).toBe(true);
  });

  it("uses Personal deletion capability instead of editability and preserves index-refresh warnings", async () => {
    const personal = vault({ id: "personal:agent-a", type: "personal", role: "owner" });
    const ids = ["source", "report", "generated"];
    const request = vi.fn(async (method: string, params: RequestParams) =>
      method === `${RPC}get`
        ? fullDocument(params.documentId, {
            vaultId: personal.id,
            revision: "a".repeat(64),
            sourceContent: "Full original Personal source",
            canDelete: params.documentId !== "generated",
            editMode: null,
            readOnlyReason: params.documentId === "source" ? "source-managed" : "generated-report",
          })
        : { deleted: true, documentId: params.documentId, indexesRefreshed: false },
    );
    const { element, results } = await mount(
      request,
      ids.map((id) => summary(id, { vaultId: personal.id })),
      personal,
    );
    await ready(element);
    expect(element.querySelectorAll('[data-delete-status="excluded"]')).toHaveLength(1);
    expect(element.querySelectorAll('[data-delete-status="ready"]')).toHaveLength(2);
    expect(element.textContent).toContain(
      platformClawT("platformClaw.vault.documentBulkDeletePersonalHint"),
    );
    confirm(element);
    await waitForFast(() => expect(results).toHaveLength(1));
    expect(deletes(request).map(([, params]) => params)).toEqual([
      { vaultId: personal.id, documentId: "source", expectedRevision: "a".repeat(64) },
      { vaultId: personal.id, documentId: "report", expectedRevision: "a".repeat(64) },
    ]);
    expect(results[0]!.items.map((item) => item.status)).toEqual([
      "deleted",
      "deleted",
      "excluded",
    ]);
    expect(results[0]!.items[0]).toMatchObject({ indexesRefreshed: false });
    expect(element.textContent).toContain(
      platformClawT("platformClaw.vault.documentBulkDeleteIndexWarning"),
    );
  });

  it("can review more than 100 explicitly selected loaded documents", async () => {
    const request = requestWithDelete();
    const documents = Array.from({ length: 101 }, (_, index) => summary(`synthetic-${index}`));
    const { element } = await mount(request, documents);
    await ready(element);
    expect(element.querySelector<HTMLButtonElement>("button.danger")!.disabled).toBe(false);
    expect(element.querySelectorAll('[data-delete-status="ready"]')).toHaveLength(101);
    expect(request).toHaveBeenCalledTimes(101);
    expect(deletes(request)).toEqual([]);
  });

  it("accounts for permission exclusions, failed reads, cross-vault selections, and malformed full documents", async () => {
    const blockedRequest = vi.fn();
    const blocked = await mount(
      blockedRequest,
      [summary("one")],
      vault({ canEdit: false, role: "reader" }),
    );
    await waitForFast(() =>
      expect(blocked.element.querySelector('[data-delete-status="excluded"]')).not.toBeNull(),
    );
    expect(blockedRequest).not.toHaveBeenCalled();
    expect(blocked.element.textContent).toContain(
      platformClawT("platformClaw.vault.documentBulkDeleteEditRequired"),
    );
    const request = vi.fn(async (_method: string, params: RequestParams) => {
      if (params.documentId === "unreadable") {
        throw new Error("Document unavailable");
      }
      return fullDocument(params.documentId, { revision: 0 });
    });
    const { element } = await mount(request, [
      summary("unreadable"),
      summary("invalid"),
      summary("foreign", { vaultId: "other" }),
    ]);
    await ready(element);
    expect(confirm(element).disabled).toBe(true);
    expect(element.querySelectorAll("[data-document-delete-result]")).toHaveLength(3);
    expect(element.querySelectorAll('[data-delete-status="read-failed"]')).toHaveLength(1);
    expect(element.querySelectorAll('[data-delete-status="excluded"]')).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(deletes(request)).toEqual([]);
  });

  it.each([
    { sourceContent: undefined, revision: "a".repeat(64) },
    { sourceContent: "Original source", revision: "stale-index-revision" },
  ])(
    "requires the full original Personal source and its hash before confirmation: %j",
    async (overrides) => {
      const personal = vault({ id: "personal:agent-a", type: "personal" });
      const request = vi
        .fn()
        .mockResolvedValue(fullDocument("one", { vaultId: personal.id, ...overrides }));
      const { element } = await mount(
        request,
        [summary("one", { vaultId: personal.id })],
        personal,
      );
      await ready(element);
      expect(confirm(element).disabled).toBe(true);
      expect(element.querySelectorAll('[data-delete-status="excluded"]')).toHaveLength(1);
      expect(deletes(request)).toEqual([]);
    },
  );

  it("discards a stale full-document read after the selected Wiki changes", async () => {
    const pending = deferred();
    const request = vi.fn().mockReturnValue(pending.promise);
    const { element } = await mount(request);
    element.vault = vault({ id: "shared-two" });
    await element.updateComplete;
    pending.resolve(fullDocument("one"));
    await element.updateComplete;
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    expect(element.querySelector("button.danger")).toBeNull();
    expect(element.textContent).not.toContain("Document one");
    expect(element.textContent).toContain(
      platformClawT("platformClaw.vault.documentBulkDeleteSessionChanged"),
    );
  });

  it.each(["cancel", "escape"])(
    "allows %s while reading and never starts another document or mutation",
    async (action) => {
      const pending = deferred();
      const request = vi.fn().mockReturnValue(pending.promise);
      const { element, close } = await mount(request);
      await element.updateComplete;
      expect(element.querySelector("button.danger")).toBeNull();
      if (action === "cancel") {
        button(element, "cancel").click();
      } else {
        element
          .querySelector("openclaw-modal-dialog")!
          .dispatchEvent(new Event("modal-cancel", { bubbles: true, cancelable: true }));
      }
      expect(close).toHaveBeenCalledOnce();
      pending.resolve(fullDocument("one"));
      await element.updateComplete;
      await Promise.resolve();
      expect(request).toHaveBeenCalledOnce();
      expect(deletes(request)).toEqual([]);
      expect(element.querySelector("button.danger")).toBeNull();
    },
  );

  it("waits for every fresh read and cancels sequential deletion only after the current result", async () => {
    const readPending = deferred();
    const deletePending = deferred();
    const request = vi.fn(async (method: string, params: RequestParams) => {
      if (method === `${RPC}delete`) {
        return deletePending.promise;
      }
      return params.documentId === "two" ? readPending.promise : fullDocument(params.documentId);
    });
    const { element, results, busy, close } = await mount(request);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(element.querySelector("button.danger")).toBeNull();
    readPending.resolve(fullDocument("two"));
    await ready(element);
    const control = confirm(element);
    control.click();
    await element.updateComplete;
    expect(deletes(request)).toHaveLength(1);
    expect(busy).toEqual([true]);
    expect(button(element, "closeDialog").disabled).toBe(true);
    const escape = new Event("modal-cancel", { bubbles: true, cancelable: true });
    element.querySelector("openclaw-modal-dialog")!.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
    button(element, "documentBulkDeleteStop").click();
    deletePending.resolve({ deleted: true, documentId: "one" });
    await waitForFast(() => expect(results).toHaveLength(1));
    expect(deletes(request)).toHaveLength(1);
    expect(results[0]!.items.map((item) => item.status)).toEqual(["deleted", "not-attempted"]);
    expect(busy).toEqual([true, false]);
    button(element, "closeDialog").click();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["client", "agent", "vault", "unmount"])(
    "does not advance or publish stale pruning after %s changes",
    async (change) => {
      const pending = deferred();
      const request = requestWithDelete(() => pending.promise);
      const { element, results, deleted } = await mount(request);
      const originalClient = element.client;
      await ready(element);
      confirm(element);
      if (change === "client") {
        element.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
      } else if (change === "agent") {
        element.agentId = "agent-b";
      } else if (change === "vault") {
        element.vault = vault({ id: "shared-two" });
      } else {
        element.remove();
      }
      await element.updateComplete;
      if (change !== "unmount") {
        expect(element.textContent).not.toContain("Document one");
      }
      pending.resolve({ deleted: true, documentId: "one" });
      await waitForFast(() => expect(results).toHaveLength(1));
      expect(deletes(request)).toHaveLength(1);
      expect(deleted).toEqual([]);
      expect(results[0]).toMatchObject({
        client: originalClient,
        agentId: "agent-a",
        vaultId: "shared-one",
      });
      expect(results[0]!.items.map((item) => item.status)).toEqual(["deleted", "not-attempted"]);
    },
  );

  it.each(["disconnect", "permission"])(
    "does not resume after %s is restored during a pending deletion",
    async (change) => {
      const pending = deferred();
      const request = requestWithDelete(() => pending.promise);
      const { element, results } = await mount(request);
      await ready(element);
      confirm(element);
      if (change === "disconnect") {
        element.connected = false;
      } else {
        element.vault = { ...element.vault, canEdit: false };
      }
      await element.updateComplete;
      element.connected = true;
      element.vault = { ...element.vault, canEdit: true };
      await element.updateComplete;
      pending.resolve({ deleted: true, documentId: "one" });
      await waitForFast(() => expect(results).toHaveLength(1));
      expect(deletes(request)).toHaveLength(1);
      expect(results[0]!.items.map((item) => item.status)).toEqual(["deleted", "not-attempted"]);
      expect(element.querySelector("button.danger")).toBeNull();
    },
  );

  it.each([
    {
      name: "revision conflict",
      error: new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Document changed; reload before deleting",
      }),
      status: "failed",
    },
    {
      name: "revoked permission",
      error: new GatewayRequestError({ code: "FORBIDDEN", message: "Editing unavailable" }),
      status: "failed",
    },
    { name: "transport loss", error: new Error("Connection closed"), status: "unconfirmed" },
    {
      name: "upstream unavailable",
      error: new GatewayRequestError({ code: "UNAVAILABLE", message: "Request unavailable" }),
      status: "unconfirmed",
    },
  ])("keeps partial success and stops without retries after $name", async ({ error, status }) => {
    const request = requestWithDelete((params) => {
      if (params.documentId === "two") {
        throw error;
      }
      return { deleted: true, documentId: params.documentId };
    });
    const { element, results, deleted } = await mount(request, [
      summary("one"),
      summary("two"),
      summary("three"),
    ]);
    await ready(element);
    confirm(element);
    await waitForFast(() => expect(results).toHaveLength(1));
    expect(deletes(request)).toHaveLength(2);
    expect(results[0]!.items.map((item) => item.status)).toEqual([
      "deleted",
      status,
      "not-attempted",
    ]);
    expect(deleted.map((event) => event.documentIds)).toEqual([["one"]]);
    expect(element.querySelector("button.danger")).toBeNull();
  });

  it.each([
    { code: "FORBIDDEN", details: undefined, status: "unconfirmed" },
    { code: "INVALID_REQUEST", details: undefined, status: "unconfirmed" },
    {
      code: "FORBIDDEN",
      details: { requestDisposition: "rejected-before-dispatch" },
      status: "failed",
    },
  ])(
    "does not mistake a Personal postcommit projection error for rejected deletion: $code / $status",
    async ({ code, details, status }) => {
      const personal = vault({ id: "personal:agent-a", type: "personal" });
      const request = vi.fn(async (method: string, params: RequestParams) => {
        if (method === `${RPC}get`) {
          return fullDocument(params.documentId, {
            vaultId: personal.id,
            revision: "a".repeat(64),
            sourceContent: "Full original Personal source",
            canDelete: true,
          });
        }
        throw new GatewayRequestError({
          code,
          details,
          message: "Gateway returned invalid personal Wiki deletion result",
        });
      });
      const { element, results, deleted } = await mount(
        request,
        [summary("one", { vaultId: personal.id }), summary("two", { vaultId: personal.id })],
        personal,
      );
      await ready(element);
      confirm(element);
      await waitForFast(() => expect(results).toHaveLength(1));
      expect(deletes(request)).toHaveLength(1);
      expect(results[0]!.items.map((item) => item.status)).toEqual([status, "not-attempted"]);
      expect(deleted).toEqual([]);
      expect(element.querySelector("button.danger")).toBeNull();
    },
  );

  it.each([
    undefined,
    { deleted: false, documentId: "one" },
    { deleted: true, documentId: "other" },
  ])("does not trust a malformed deletion receipt: %j", async (response) => {
    const request = requestWithDelete(() => response);
    const { element, results, deleted } = await mount(request);
    await ready(element);
    confirm(element);
    await waitForFast(() => expect(results).toHaveLength(1));
    expect(deletes(request)).toHaveLength(1);
    expect(results[0]!.items.map((item) => item.status)).toEqual(["unconfirmed", "not-attempted"]);
    expect(deleted).toEqual([]);
  });

  it("uses the real Gateway timeout on a live socket and ignores a late success without retrying", async () => {
    vi.useFakeTimers();
    const sockets: TestSocket[] = [];
    class TestSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = TestSocket.OPEN;
      readonly sent: Array<{ id: string; method: string; params?: RequestParams }> = [];
      constructor(_url: string) {
        super();
        sockets.push(this);
      }
      send(data: string) {
        const frame = JSON.parse(data) as (typeof this.sent)[number];
        this.sent.push(frame);
        if (frame.method === `${RPC}get`) {
          queueMicrotask(() =>
            this.receive({
              type: "res",
              id: frame.id,
              ok: true,
              payload: fullDocument(frame.params!.documentId),
            }),
          );
        }
      }
      close() {
        this.readyState = 3;
      }
      receive(frame: unknown) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      }
    }
    vi.stubGlobal("WebSocket", TestSocket);
    const client = new GatewayBrowserClient({
      url: "ws://gateway.example",
      browserDeviceAuth: false,
    });
    try {
      client.start();
      const socket = sockets[0]!;
      socket.dispatchEvent(new Event("open"));
      socket.receive({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "synthetic-nonce", ts: 1 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.sent[0]?.method).toBe("connect");
      socket.receive({
        type: "res",
        id: socket.sent[0]!.id,
        ok: true,
        payload: { type: "hello-ok", protocol: 3, policy: { tickIntervalMs: 30_000 } },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.connected).toBe(true);
      const request = vi.fn(client.request.bind(client));
      const { element, results, busy, deleted } = await mount(request);
      await vi.advanceTimersByTimeAsync(0);
      await element.updateComplete;
      confirm(element);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(results).toHaveLength(0);
      socket.receive({ type: "event", event: "tick", payload: {} });
      await vi.advanceTimersByTimeAsync(1);
      await element.updateComplete;
      expect(client.connected).toBe(true);
      expect(results).toHaveLength(1);
      expect(results[0]!.items.map((item) => item.status)).toEqual([
        "unconfirmed",
        "not-attempted",
      ]);
      expect(busy).toEqual([true, false]);
      expect(button(element, "closeDialog").disabled).toBe(false);
      const mutation = socket.sent.find((frame) => frame.method === `${RPC}delete`)!;
      socket.receive({
        type: "res",
        id: mutation.id,
        ok: true,
        payload: { deleted: true, documentId: "one" },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(deletes(request)).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect(deleted).toEqual([]);
    } finally {
      client.stop();
    }
  });
});
