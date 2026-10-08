/* @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeVaultDocument,
  KnowledgeVaultDocumentPublishInput,
  KnowledgeVaultDocumentPublishResult,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import "./memory-vault-document-bulk-publish.ts";
type PlatformClawVaultDocumentBulkPublish =
  HTMLElementTagNameMap["platformclaw-vault-document-bulk-publish"];

const RPC = "platformclaw.vault.";
const PUBLISH = `${RPC}document.publish`;
const PERSONAL = "personal:synthetic-agent";
type PublishRequest = Omit<KnowledgeVaultDocumentPublishInput, "userId">;
const compile = {
  status: "ready" as const,
  indexedRevision: 1,
  error: null,
  attempts: 0,
  retryAt: null,
};
const personal = {
  id: PERSONAL,
  name: "Synthetic Personal",
  type: "personal" as const,
  description: "Synthetic test notes",
  role: "owner" as const,
  canRead: true,
  canEdit: true,
  canManageMembers: false,
  canExport: true,
  createdAt: 1,
  updatedAt: 1,
  connected: true,
};
const shared = {
  ...personal,
  id: "synthetic-shared",
  name: "Synthetic Shared",
  type: "shared" as const,
};
function source(
  index: number,
  body = `# Synthetic ${index}\n\nFull original text.`,
): KnowledgeVaultDocument {
  const path = `concepts/synthetic-${index}.md`;
  return {
    id: path,
    vaultId: PERSONAL,
    title: `Synthetic ${index}`,
    logicalPath: path,
    revision: "a".repeat(64),
    updatedAt: 1,
    content: "Display excerpt only",
    editableContent: "Editable notes only",
    sourceContent: body,
    links: [],
    backlinks: [],
    compile,
  };
}
function published(
  params: PublishRequest,
  status: "published" | "unchanged" = "published",
): KnowledgeVaultDocumentPublishResult {
  const rootPath = `imports/${params.publishId}`;
  return {
    publishId: params.publishId,
    targetVaultId: params.targetVaultId,
    rootPath,
    documents: params.documents.map(({ documentId }) => ({
      sourceDocumentId: documentId,
      status,
      documentId: `copy:${documentId}`,
      logicalPath: `${rootPath}/${documentId}`,
      revision: 1,
      compile,
    })),
  };
}
function fixture(documents = [source(1), source(2)]) {
  const context = {
    documents,
    snapshot: {
      vaults: [
        personal,
        shared,
        { ...shared, id: "synthetic-reader", name: "Read only", canEdit: false, role: "reader" },
      ],
      selectionRevision: 1,
      ownRequests: [],
      pendingRequests: [],
    } as KnowledgeVaultSnapshot,
    publish: async (params: PublishRequest): Promise<KnowledgeVaultDocumentPublishResult> =>
      published(params),
    read: async (documentId: string) => documents.find((document) => document.id === documentId)!,
  };
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === `${RPC}snapshot`) {
      return context.snapshot;
    }
    if (method === `${RPC}document.get`) {
      return context.read(String(params.documentId));
    }
    if (method === PUBLISH) {
      return context.publish(params as PublishRequest);
    }
    throw new Error(`Unexpected method ${method}`);
  });
  return { context, request };
}
function mount(
  f: ReturnType<typeof fixture>,
  overrides: Partial<PlatformClawVaultDocumentBulkPublish> = {},
) {
  const element = document.createElement(
    "platformclaw-vault-document-bulk-publish",
  ) as PlatformClawVaultDocumentBulkPublish;
  Object.assign(element, {
    client: { request: f.request } as unknown as GatewayBrowserClient,
    connected: true,
    methods: [PUBLISH, `${RPC}document.get`],
    agentId: "synthetic-agent",
    vault: personal,
    documents: f.context.documents.map((document) => ({ ...document, revision: "stale-summary" })),
    ...overrides,
  });
  document.body.append(element);
  return element;
}
async function ready(element: PlatformClawVaultDocumentBulkPublish, count: number) {
  await waitForFast(() => {
    expect(element.querySelectorAll("[data-publish-status]")).toHaveLength(count);
    expect(element.querySelectorAll('[data-publish-status="loading"]')).toHaveLength(0);
  });
}
function button(element: Element, name: string) {
  const result = [...element.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name,
  );
  expect(result, name).toBeDefined();
  return result!;
}
function submit(element: Element) {
  return element.querySelector<HTMLButtonElement>("[data-publish-submit]")!;
}
async function approve(element: PlatformClawVaultDocumentBulkPublish, target?: string) {
  if (target) {
    const select = element.querySelector<HTMLSelectElement>("[data-publish-destination]")!;
    select.value = target;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
  }
  element.querySelector<HTMLInputElement>("[data-publish-reviewed]")!.click();
  await element.updateComplete;
  expect(submit(element).disabled).toBe(false);
}
function publishes(f: ReturnType<typeof fixture>) {
  return f.request.mock.calls
    .filter(([method]) => method === PUBLISH)
    .map(([, params]) => params as PublishRequest);
}
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("selected Personal document publication", () => {
  it("reviews exact full sources and an explicit editable Shared destination without reading linked pages", async () => {
    // Insecure company origins may offer secure random bytes without crypto.subtle.
    vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const body =
      "\uFEFF---\r\ntitle: Synthetic source\r\n---\r\n# Full source\r\n[Unselected](private.md)\r\n![External](https://example.invalid/image.png)\r\n  Preserve spaces.  \r\n";
    const documents = [
      source(1, body),
      { ...source(2), editMode: null, readOnlyReason: "generated-report" },
    ];
    const f = fixture(documents);
    f.context.snapshot.vaults.push({ ...shared, id: "synthetic-other", name: "Other editable" });
    const element = mount(f);
    const complete = vi.fn();
    element.addEventListener("document-publish-complete", complete);
    await ready(element, 2);
    expect(element.querySelector(".vaults__source")?.textContent).toBe(body);
    expect(element.querySelector("img")).toBeNull();
    expect([...element.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "",
      shared.id,
      "synthetic-other",
    ]);
    expect(submit(element).disabled).toBe(true);
    expect(publishes(f)).toHaveLength(0);
    button(element, "Synthetic 2").click();
    await element.updateComplete;
    expect(element.querySelector(".vaults__source")?.textContent).toBe(documents[1]!.sourceContent);
    await approve(element, shared.id);
    submit(element).click();
    await waitForFast(() => expect(complete).toHaveBeenCalledOnce());
    expect(publishes(f)).toEqual([
      {
        vaultId: PERSONAL,
        targetVaultId: shared.id,
        publishId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
        documents: documents.map((document) => ({
          documentId: document.id,
          expectedRevision: document.revision,
        })),
      },
    ]);
    expect(
      f.request.mock.calls
        .filter(([method]) => method === `${RPC}document.get`)
        .map(([, params]) => params.documentId),
    ).toEqual(documents.map((document) => document.id));
    expect(element.querySelectorAll('[data-publish-status="published"]')).toHaveLength(2);
    expect(element.querySelector("[data-document-bulk-publish]")).not.toBeNull();
    expect(
      f.request.mock.calls.every(([method]) =>
        [`${RPC}document.get`, `${RPC}snapshot`, PUBLISH].includes(method),
      ),
    ).toBe(true);
    expect(complete.mock.calls[0]![0].detail).toMatchObject({
      confirmedDocumentIds: documents.map((document) => document.id),
      published: 2,
      unchanged: 0,
      failed: 0,
      uncertain: 0,
      pending: 0,
    });
  });

  it.each([
    { count: 21, bytes: 64, chunks: [20, 1] },
    { count: 5, bytes: 1024 * 1024, chunks: [4, 1] },
  ])(
    "bounds $count selected sources by both count and bytes under one copy identity",
    async ({ count, bytes, chunks }) => {
      const f = fixture(
        Array.from({ length: count }, (_, index) => source(index, "# " + "a".repeat(bytes - 2))),
      );
      const element = mount(f);
      await ready(element, count);
      await approve(element);
      submit(element).click();
      await waitForFast(() =>
        expect(element.querySelectorAll('[data-publish-status="published"]')).toHaveLength(count),
      );
      expect(publishes(f).map((params) => params.documents.length)).toEqual(chunks);
      expect(new Set(publishes(f).map((params) => params.publishId)).size).toBe(1);
    },
  );

  it("stops after the current batch and resumes only on an explicit click", async () => {
    const f = fixture(Array.from({ length: 21 }, (_, index) => source(index)));
    let resolve!: (result: KnowledgeVaultDocumentPublishResult) => void;
    const first = new Promise<KnowledgeVaultDocumentPublishResult>((done) => {
      resolve = done;
    });
    f.context.publish = async (params) => (publishes(f).length === 1 ? first : published(params));
    const element = mount(f);
    await ready(element, 21);
    await approve(element);
    submit(element).click();
    await waitForFast(() => expect(publishes(f)).toHaveLength(1));
    submit(element).click();
    expect(publishes(f)).toHaveLength(1);
    button(element, "Cancel after current batch").click();
    resolve(published(publishes(f)[0]!));
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-publish-status="published"]')).toHaveLength(20),
    );
    expect(publishes(f)).toHaveLength(1);
    expect(element.querySelectorAll('[data-publish-status="ready"]')).toHaveLength(1);
    submit(element).click();
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-publish-status="published"]')).toHaveLength(21),
    );
    expect(publishes(f)[1]!.publishId).toBe(publishes(f)[0]!.publishId);
  });

  it("preserves exact pins on a disconnected unknown retry and ignores the late original result", async () => {
    const f = fixture();
    let resolve!: (result: KnowledgeVaultDocumentPublishResult) => void;
    const first = new Promise<KnowledgeVaultDocumentPublishResult>((done) => {
      resolve = done;
    });
    f.context.publish = async (params) =>
      publishes(f).length === 1 ? first : published(params, "unchanged");
    const element = mount(f);
    await ready(element, 2);
    await approve(element);
    submit(element).click();
    await waitForFast(() => expect(publishes(f)).toHaveLength(1));
    element.connected = false;
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-publish-status="uncertain"]')).toHaveLength(2),
    );
    element.connected = true;
    await element.updateComplete;
    expect(publishes(f)).toHaveLength(1);
    const close = vi.fn();
    element.addEventListener("document-publish-close", close);
    button(element, "Close dialog").click();
    await element.updateComplete;
    expect(element.textContent).toContain("Closing loses this safe-retry session");
    const escape = new Event("modal-cancel", { cancelable: true });
    element.querySelector("openclaw-modal-dialog")!.dispatchEvent(escape);
    await element.updateComplete;
    expect(escape.defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
    submit(element).click();
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-publish-status="unchanged"]')).toHaveLength(2),
    );
    expect(publishes(f)[1]).toEqual(publishes(f)[0]);
    resolve(published(publishes(f)[0]!));
    await first;
    await element.updateComplete;
    expect(element.querySelectorAll('[data-publish-status="unchanged"]')).toHaveLength(2);
    expect(f.request.mock.calls.filter(([method]) => method === `${RPC}document.get`)).toHaveLength(
      2,
    );
  });

  it("reports every mixed result and retries only known transient failures", async () => {
    const f = fixture([source(1), source(2), source(3), source(4)]);
    f.context.publish = async (params) => {
      const result = published(params);
      if (publishes(f).length === 1) {
        const first = result.documents[0]!;
        if (first.status !== "failed") {
          first.compile = { ...compile, status: "pending" };
        }
        result.documents[1] = {
          sourceDocumentId: params.documents[1]!.documentId,
          status: "failed",
          error: "conflict",
        };
        result.documents[2] = {
          sourceDocumentId: params.documents[2]!.documentId,
          status: "failed",
          error: "unavailable",
        };
        result.documents[3] = {
          sourceDocumentId: params.documents[3]!.documentId,
          status: "failed",
          error: "forbidden",
        };
      }
      return result;
    };
    const element = mount(f);
    const complete = vi.fn();
    element.addEventListener("document-publish-complete", complete);
    await ready(element, 4);
    await approve(element);
    submit(element).click();
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-publish-status="failed"]')).toHaveLength(3),
    );
    expect(complete.mock.calls[0]![0].detail.confirmedDocumentIds).toEqual([source(1).id]);
    expect(element.textContent).toContain("search and links are still updating");
    expect(element.textContent).toContain("existing copies were not overwritten");
    submit(element).click();
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-publish-status="published"]')).toHaveLength(2),
    );
    expect(publishes(f)[1]!.documents).toEqual([
      { documentId: source(3).id, expectedRevision: source(3).revision },
    ]);
    expect(complete.mock.calls[1]![0].detail.confirmedDocumentIds).toEqual([
      source(1).id,
      source(3).id,
    ]);
  });

  it.each(["missing", "wrong-target", "duplicate", "malformed"])(
    "keeps a %s response unconfirmed for safe replay",
    async (failure) => {
      const f = fixture();
      f.context.publish = async (params) => {
        const result = published(params);
        if (failure === "missing") {
          result.documents.pop();
        }
        if (failure === "wrong-target") {
          result.targetVaultId = "unexpected-target";
        }
        if (failure === "duplicate") {
          result.documents[1] = result.documents[0]!;
        }
        if (failure === "malformed" && result.documents[0]!.status !== "failed") {
          result.documents[0]!.logicalPath = `${result.rootPath}/concepts/unselected.md`;
        }
        return result;
      };
      const element = mount(f);
      await ready(element, 2);
      await approve(element);
      submit(element).click();
      await waitForFast(() =>
        expect(element.querySelectorAll('[data-publish-status="uncertain"]')).toHaveLength(2),
      );
      expect(element.textContent).toContain("did not confirm every selected document");
      expect(publishes(f)).toHaveLength(1);
    },
  );

  it.each(["client", "agent", "vault", "selection"])(
    "invalidates old preparation after a %s change",
    async (change) => {
      const f = fixture([source(1)]);
      let resolve!: (document: KnowledgeVaultDocument) => void;
      const first = new Promise<KnowledgeVaultDocument>((done) => {
        resolve = done;
      });
      f.context.read = async () => first;
      const element = mount(f);
      await waitForFast(() =>
        expect(f.request).toHaveBeenCalledWith(
          `${RPC}document.get`,
          {
            vaultId: PERSONAL,
            documentId: source(1).id,
          },
          { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
        ),
      );
      if (change === "client") {
        element.client = null;
      }
      if (change === "agent") {
        element.agentId = "another-agent";
      }
      if (change === "vault") {
        element.vault = shared;
      }
      if (change === "selection") {
        element.documents = [];
      }
      await element.updateComplete;
      resolve(source(1));
      await first;
      await element.updateComplete;
      expect(element.querySelector(".vaults__source")).toBeNull();
      expect(submit(element).disabled).toBe(true);
      expect(publishes(f)).toHaveLength(0);
    },
  );

  it("ignores an in-flight publish result after the Personal identity changes", async () => {
    const f = fixture();
    let resolve!: (result: KnowledgeVaultDocumentPublishResult) => void;
    const pending = new Promise<KnowledgeVaultDocumentPublishResult>((done) => {
      resolve = done;
    });
    f.context.publish = async () => pending;
    const element = mount(f);
    const complete = vi.fn();
    element.addEventListener("document-publish-complete", complete);
    await ready(element, 2);
    await approve(element);
    submit(element).click();
    await waitForFast(() => expect(publishes(f)).toHaveLength(1));
    element.agentId = "different-synthetic-agent";
    await element.updateComplete;
    resolve(published(publishes(f)[0]!));
    await pending;
    await element.updateComplete;
    expect(element.querySelectorAll('[data-publish-status="published"]')).toHaveLength(0);
    expect(element.querySelector(".vaults__source")).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    expect(publishes(f)).toHaveLength(1);
  });

  it.each(["missing-source", "wrong-id", "wrong-revision", "oversized"])(
    "blocks an invalid %s source without copying other selected documents",
    async (kind) => {
      const documents = [source(1), source(2)];
      if (kind === "missing-source") {
        delete documents[0]!.sourceContent;
      }
      if (kind === "wrong-revision") {
        documents[0]!.revision = "not-a-full-source-hash";
      }
      if (kind === "oversized") {
        documents[0]!.sourceContent = "a".repeat(1024 * 1024 + 1);
      }
      const f = fixture(documents);
      if (kind === "wrong-id") {
        f.context.read = async () => source(999);
      }
      const element = mount(f);
      await ready(element, 2);
      expect(element.querySelectorAll('[data-publish-status="invalid"]').length).toBeGreaterThan(0);
      expect(submit(element).disabled).toBe(true);
      expect(publishes(f)).toHaveLength(0);
    },
  );

  it("blocks oversized or read-only selections before making source requests", async () => {
    const f = fixture(Array.from({ length: 1001 }, (_, index) => source(index)));
    const element = mount(f);
    await waitForFast(() => expect(element.textContent).toContain("Select 1–1000 documents"));
    expect(f.request).not.toHaveBeenCalled();
    element.documents = [source(1)];
    element.vault = { ...personal, canEdit: false };
    await waitForFast(() =>
      expect(element.textContent).toContain("your own readable Personal Wiki"),
    );
    expect(f.request).not.toHaveBeenCalled();
  });

  it("refreshes destination access before copying and allows safe retry after permission is restored", async () => {
    const f = fixture();
    f.context.publish = async () => {
      throw new Error("Synthetic lost response");
    };
    const element = mount(f);
    await ready(element, 2);
    await approve(element);
    submit(element).click();
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-publish-status="uncertain"]')).toHaveLength(2),
    );
    f.context.snapshot = {
      ...f.context.snapshot,
      vaults: [personal, { ...shared, canEdit: false }],
    };
    submit(element).click();
    await waitForFast(() =>
      expect(element.textContent).toContain("destination is no longer editable"),
    );
    expect(publishes(f)).toHaveLength(1);
    expect(element.querySelector<HTMLSelectElement>("[data-publish-destination]")!.disabled).toBe(
      true,
    );
    f.context.snapshot = { ...f.context.snapshot, vaults: [personal, shared] };
    f.context.publish = async (params) => published(params, "unchanged");
    submit(element).click();
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-publish-status="unchanged"]')).toHaveLength(2),
    );
    expect(publishes(f)[1]).toEqual(publishes(f)[0]);
  });
  it.each(["snapshot", "document.get", "document.publish"])(
    "bounds %s on a ticking real Gateway socket and never automatically retries",
    async (blocked) => {
      vi.useFakeTimers();
      const f = fixture(
        blocked === "document.publish"
          ? Array.from({ length: 21 }, (_, index) => source(index))
          : [source(1)],
      );
      const sockets: TestSocket[] = [];
      class TestSocket extends EventTarget {
        static readonly OPEN = 1;
        readyState = TestSocket.OPEN;
        readonly sent: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
        constructor(_url: string) {
          super();
          sockets.push(this);
        }
        send(data: string) {
          const frame = JSON.parse(data) as (typeof this.sent)[number];
          this.sent.push(frame);
          if (frame.method === "connect" || frame.method === `${RPC}${blocked}`) {
            return;
          }
          const payload =
            frame.method === `${RPC}snapshot`
              ? f.context.snapshot
              : f.context.documents.find((item) => item.id === frame.params.documentId);
          queueMicrotask(() => this.receive({ type: "res", id: frame.id, ok: true, payload }));
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
        const element = mount(f, { client });
        const complete = vi.fn();
        element.addEventListener("document-publish-complete", complete);
        await vi.advanceTimersByTimeAsync(0);
        await element.updateComplete;
        if (blocked === "document.publish") {
          expect(element.querySelectorAll('[data-publish-status="ready"]')).toHaveLength(21);
          await approve(element);
          submit(element).click();
          await vi.advanceTimersByTimeAsync(0);
        }
        await vi.advanceTimersByTimeAsync(29_999);
        expect(element.querySelectorAll('[data-publish-status="uncertain"]')).toHaveLength(0);
        socket.receive({ type: "event", event: "tick", payload: {} });
        await vi.advanceTimersByTimeAsync(1);
        await element.updateComplete;
        expect(client.connected).toBe(true);
        if (blocked === "document.publish") {
          expect(element.querySelectorAll('[data-publish-status="uncertain"]')).toHaveLength(20);
          expect(element.querySelectorAll('[data-publish-status="ready"]')).toHaveLength(1);
          expect(complete).toHaveBeenCalledOnce();
          const mutation = socket.sent.find((frame) => frame.method === PUBLISH)!;
          socket.receive({
            type: "res",
            id: mutation.id,
            ok: true,
            payload: published(mutation.params as PublishRequest),
          });
          await vi.advanceTimersByTimeAsync(0);
          expect(element.querySelectorAll('[data-publish-status="uncertain"]')).toHaveLength(20);
          expect(socket.sent.filter((frame) => frame.method === PUBLISH)).toHaveLength(1);
          expect(submit(element).disabled).toBe(false);
        } else {
          expect(element.querySelectorAll('[data-publish-status="invalid"]')).toHaveLength(1);
          expect(button(element, "Reload selected sources").disabled).toBe(false);
          expect(socket.sent.filter((frame) => frame.method === PUBLISH)).toHaveLength(0);
        }
      } finally {
        client.stop();
      }
    },
  );

  it("aborts pending preparation when closed and does not read the next source", async () => {
    const f = fixture();
    let resolve!: (document: KnowledgeVaultDocument) => void;
    const pending = new Promise<KnowledgeVaultDocument>((done) => {
      resolve = done;
    });
    f.context.read = async () => pending;
    const request = vi.fn(
      (
        method: string,
        params: Record<string, unknown>,
        _options?: { timeoutMs?: number; signal?: AbortSignal },
      ) => f.request(method, params),
    );
    const element = mount(f, { client: { request } as unknown as GatewayBrowserClient });
    await waitForFast(() =>
      expect(request.mock.calls.some(([method]) => method === `${RPC}document.get`)).toBe(true),
    );
    const close = vi.fn();
    element.addEventListener("document-publish-close", close);
    button(element, "Cancel").click();
    expect(close).toHaveBeenCalledOnce();
    const read = request.mock.calls.find(([method]) => method === `${RPC}document.get`)!;
    expect((read[2] as { signal: AbortSignal }).signal.aborted).toBe(true);
    resolve(source(1));
    await pending;
    await element.updateComplete;
    expect(request.mock.calls.filter(([method]) => method === `${RPC}document.get`)).toHaveLength(
      1,
    );
    expect(publishes(f)).toHaveLength(0);
  });
});
