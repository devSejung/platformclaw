import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { setupBrowserKnowledgeVault } from "./browser-gateway-vault.test-harness.js";
import {
  KNOWLEDGE_VAULT_LIMITS,
  type KnowledgeVaultDocumentPublishResult,
} from "./knowledge-vault-contracts.js";
import { publishKnowledgeVaultDocuments } from "./knowledge-vault-publication.js";
import { KnowledgeVaultService } from "./knowledge-vault-service.js";
import { SqliteKnowledgeVaultStore } from "./sqlite-knowledge-vault-store.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const PUBLISH_ID = "d307b02c-e198-4bcb-af01-df3bb5ab0b62";
const METHOD = "platformclaw.vault.document.publish";
const hash = (content: string) => createHash("sha256").update(content).digest("hex");

async function fixture() {
  const f = await setupBrowserKnowledgeVault();
  const vault = f.store.vaults.createVault({ userId: f.user.id, name: "Shared destination" });
  const sources = new Map([
    ["concepts/folder/A.md", "\uFEFF---\r\ntitle: A\r\nprivate: reviewed\r\n---\r\n[B](B.md)\r\n"],
    ["concepts/folder/B.md", "# B\n[A](A.md) [Unselected](C.md)\n"],
  ]);
  f.request.mockImplementation(async (method, params) => {
    expect(method).toBe("wiki.document.get");
    if (!isRecord(params)) {
      throw new Error("Expected source read parameters");
    }
    expect(params.agentId).toBe(f.binding.agentId);
    const content = sources.get(String(params.lookup));
    return content === undefined
      ? null
      : {
          path: params.lookup,
          title: String(params.lookup).split("/").at(-1),
          kind: "concept",
          sourceContent: content,
          displayContent: "Read-only source preview",
          editMode: null,
          readOnlyReason: "source-managed",
          revision: hash(content),
        };
  });
  const input = {
    vaultId: `personal:${f.binding.agentId}`,
    targetVaultId: vault.id,
    publishId: PUBLISH_ID,
    documents: [...sources].map(([documentId, content]) => ({
      documentId,
      expectedRevision: hash(content),
    })),
  };
  const publish = (request = input) =>
    f.proxy.request<KnowledgeVaultDocumentPublishResult>(f.token, METHOD, request);
  const selected = () =>
    f.store.vaults.snapshot({ userId: f.user.id, vaultId: vault.id }).selected!;
  return { ...f, vault, sources, input, publish, selected };
}

describe("revision-pinned document publication boundary", () => {
  it("copies only reviewed originals, preserves relative links, and reconciles lost replies across restart", async () => {
    const f = await fixture();
    const originals = [...f.sources];
    const published = await f.publish();
    expect(published).toMatchObject({
      publishId: PUBLISH_ID,
      targetVaultId: f.vault.id,
      rootPath: `imports/${PUBLISH_ID}`,
    });
    expect(published.documents.map((item) => item.status)).toEqual(["published", "published"]);
    const selected = f.selected();
    expect(selected.documents).toHaveLength(2);
    expect(selected.graph.edges).toHaveLength(2);
    expect(selected.graph.unresolvedLinks).toBe(1);
    for (const document of selected.documents) {
      const sourcePath = document.logicalPath.slice(published.rootPath.length + 1);
      expect(
        f.store.vaults.readDocument({
          userId: f.user.id,
          vaultId: f.vault.id,
          documentId: document.id,
        }).content,
      ).toBe(f.sources.get(sourcePath));
    }
    expect([...f.sources]).toEqual(originals);
    expect(f.request).toHaveBeenCalledTimes(2);

    f.sources.clear();
    f.request.mockClear();
    const reopened = new SqliteControlPlaneStore({
      databasePath: f.databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
    try {
      const service = new KnowledgeVaultService(reopened, { request: f.request });
      const replay = await service.publishDocuments({ userId: f.user.id, ...f.input });
      expect(replay.documents).toEqual(
        published.documents.map((item) => Object.assign({}, item, { status: "unchanged" })),
      );
      expect(f.request).not.toHaveBeenCalled();
      expect(f.selected().documents).toEqual(selected.documents);
    } finally {
      reopened.close();
    }
  });

  it("continues mixed outcomes and retries only the unchanged original identities", async () => {
    const f = await fixture();
    const [first, second] = f.input.documents;
    f.sources.set(second!.documentId, "Changed after review");
    const missing = { documentId: "concepts/missing.md", expectedRevision: "a".repeat(64) };
    const input = { ...f.input, documents: [first!, second!, missing] };
    const result = await f.publish(input);
    expect(result.documents).toEqual([
      expect.objectContaining({
        sourceDocumentId: first!.documentId,
        status: "published",
        revision: 1,
        compile: expect.objectContaining({ status: "ready" }),
      }),
      { sourceDocumentId: second!.documentId, status: "failed", error: "conflict" },
      { sourceDocumentId: missing.documentId, status: "failed", error: "unavailable" },
    ]);
    f.sources.set(second!.documentId, "# B\n[A](A.md) [Unselected](C.md)\n");
    const retry = await f.publish(input);
    expect(retry.documents.map((item) => item.status)).toEqual([
      "unchanged",
      "published",
      "failed",
    ]);
    expect(f.selected().documents).toHaveLength(2);
  });

  it("reconciles concurrent identical requests without creating a second copy", async () => {
    const f = await fixture();
    const input = { ...f.input, documents: [f.input.documents[0]!] };
    const results = await Promise.all([f.publish(input), f.publish(input)]);
    expect(
      results.flatMap((result) => result.documents.map((item) => item.status)).toSorted(),
    ).toEqual(["published", "unchanged"]);
    expect(f.selected().documents).toHaveLength(1);
  });

  it("returns the saved source with compile failure and retains its successful receipt", async () => {
    const f = await fixture();
    const db = new DatabaseSync(f.databasePath);
    try {
      const store = new SqliteKnowledgeVaultStore(db, () => {
        throw new Error("Injected compiler failure");
      });
      const result = await publishKnowledgeVaultDocuments(
        store,
        { request: f.request },
        { userId: f.user.id, ...f.input },
      );
      expect(
        result.documents.every(
          (item) => item.status === "published" && item.compile.status === "failed",
        ),
      ).toBe(true);
      expect(f.selected().documents).toHaveLength(2);
      f.request.mockClear();
      expect(
        (await f.publish()).documents.every(
          (item) => item.status === "unchanged" && item.compile.status === "failed",
        ),
      ).toBe(true);
      expect(f.request).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each(["edit", "move", "delete", "replace"] as const)(
    "never overwrites or resurrects a %s after an uncertain response",
    async (change) => {
      const f = await fixture();
      await f.publish();
      const document = f.selected().documents[0]!;
      if (change === "edit" || change === "move") {
        f.store.vaults.saveDocument({
          userId: f.user.id,
          vaultId: f.vault.id,
          documentId: document.id,
          expectedRevision: document.revision,
          logicalPath: change === "move" ? "moved.md" : document.logicalPath,
          content:
            change === "edit"
              ? "Another editor's new body"
              : f.sources.get(f.input.documents[0]!.documentId)!,
        });
      } else {
        f.store.vaults.deleteDocument({
          userId: f.user.id,
          vaultId: f.vault.id,
          documentId: document.id,
          expectedRevision: document.revision,
        });
        if (change === "replace") {
          f.store.vaults.saveDocument({
            userId: f.user.id,
            vaultId: f.vault.id,
            logicalPath: document.logicalPath,
            content: f.sources.get(f.input.documents[0]!.documentId)!,
          });
        }
      }
      const before = f.selected();
      f.request.mockClear();
      const replay = await f.publish();
      expect(replay.documents[0]).toEqual({
        sourceDocumentId: f.input.documents[0]!.documentId,
        status: "failed",
        error: "conflict",
      });
      expect(replay.documents[1]?.status).toBe("unchanged");
      expect(f.selected()).toEqual(before);
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("rejects unrelated path collisions and reusing a receipt for a different revision or destination", async () => {
    const f = await fixture();
    const path = `imports/${PUBLISH_ID}/${f.input.documents[0]!.documentId}`;
    const unrelated = f.store.vaults.saveDocument({
      userId: f.user.id,
      vaultId: f.vault.id,
      logicalPath: path,
      content: [...f.sources.values()][0]!,
    });
    const result = await f.publish();
    expect(result.documents[0]).toMatchObject({ status: "failed", error: "conflict" });
    expect(f.selected().documents.find((item) => item.logicalPath === path)?.id).toBe(unrelated.id);
    const source = f.input.documents[1]!;
    const changed = await f.publish({
      ...f.input,
      documents: [{ ...source, expectedRevision: "c".repeat(64) }],
    });
    expect(changed.documents[0]).toMatchObject({ status: "failed", error: "conflict" });
    const other = f.store.vaults.createVault({ userId: f.user.id, name: "Other Shared" });
    const moved = await f.publish({ ...f.input, targetVaultId: other.id, documents: [source] });
    expect(moved.documents[0]).toMatchObject({ status: "failed", error: "conflict" });
    expect(
      f.store.vaults.snapshot({ userId: f.user.id, vaultId: other.id }).selected!.documents,
    ).toHaveLength(0);
  });

  it("rechecks destination permission after the source fetch, including receipt replay", async () => {
    const f = await fixture();
    const { user: otherOwner } = await f.store.upsertPrincipal(
      { provider: "ldap", subject: "owner", accountId: "owner", employeeId: "owner" },
      Date.now(),
    );
    f.store.vaults.setMember({
      userId: f.user.id,
      vaultId: f.vault.id,
      memberUserId: otherOwner.id,
      role: "owner",
    });
    const read = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(async (method, params) => {
      const result = await read(method, params);
      f.store.vaults.setMember({
        userId: f.user.id,
        vaultId: f.vault.id,
        memberUserId: f.user.id,
        role: "reader",
      });
      return result;
    });
    const denied = await f.publish();
    expect(denied.documents.map((item) => item.status === "failed" && item.error)).toEqual([
      "forbidden",
      "forbidden",
    ]);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.selected().documents).toHaveLength(0);
    f.store.vaults.setMember({
      userId: otherOwner.id,
      vaultId: f.vault.id,
      memberUserId: f.user.id,
      role: "owner",
    });
    await f.publish();
    f.store.vaults.setMember({
      userId: f.user.id,
      vaultId: f.vault.id,
      memberUserId: f.user.id,
      role: "reader",
    });
    f.request.mockClear();
    expect(
      (await f.publish()).documents.every(
        (item) => item.status === "failed" && item.error === "forbidden",
      ),
    ).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rechecks the active Personal binding after the source fetch", async () => {
    const f = await fixture();
    const read = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(async (method, params) => {
      const result = await read(method, params);
      await f.store.transitionAgent({
        bindingId: f.binding.id,
        state: "disabled",
        changedAt: Date.now(),
      });
      return result;
    });
    expect(
      (await f.publish()).documents.every(
        (item) => item.status === "failed" && item.error === "forbidden",
      ),
    ).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.selected().documents).toHaveLength(0);
  });

  it("rolls back the document if its durable receipt cannot commit", async () => {
    const f = await fixture();
    const db = new DatabaseSync(f.databasePath);
    try {
      db.exec(
        "CREATE TRIGGER fail_publication BEFORE INSERT ON knowledge_vault_document_publications BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
      );
      const failed = await f.publish();
      expect(
        failed.documents.every((item) => item.status === "failed" && item.error === "unavailable"),
      ).toBe(true);
      expect(f.selected().documents).toHaveLength(0);
      db.exec("DROP TRIGGER fail_publication");
      expect((await f.publish()).documents.every((item) => item.status === "published")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("validates hostile request shape and source scope before any read or write", async () => {
    const f = await fixture();
    for (const input of [
      { ...f.input, documents: [] },
      { ...f.input, publishId: "../escape" },
      { ...f.input, documents: [f.input.documents[0], f.input.documents[0]] },
      {
        ...f.input,
        documents: Array.from({ length: 101 }, (_, index) => ({
          documentId: `concepts/${index}.md`,
          expectedRevision: "a".repeat(64),
        })),
      },
      { ...f.input, documents: [{ ...f.input.documents[0], expectedRevision: "stale" }] },
      { ...f.input, documents: [{ ...f.input.documents[0], content: "Injected" }] },
    ]) {
      await expect(f.proxy.request(f.token, METHOD, input)).rejects.toMatchObject({
        code: "invalid-params",
      });
    }
    for (const extra of [
      { agentId: "other" },
      { vaultId: "personal:other" },
      { vaultId: f.vault.id },
    ]) {
      await expect(
        f.proxy.request(f.token, METHOD, { ...f.input, ...extra }),
      ).rejects.toMatchObject({ code: "method-not-allowed" });
    }
    const paths = [
      "../outside.md",
      "concepts/index.md",
      "concepts/../secret.md",
      `concepts/${"x".repeat(490)}.md`,
    ];
    const result = await f.publish({
      ...f.input,
      documents: paths.map((documentId) => ({ documentId, expectedRevision: "a".repeat(64) })),
    });
    expect(
      result.documents.every((item) => item.status === "failed" && item.error === "invalid"),
    ).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.selected().documents).toHaveLength(0);
  });

  it("bounds source bytes and stops further source fetches when a batch exceeds its cap", async () => {
    const f = await fixture();
    f.sources.clear();
    const documents = Array.from({ length: 7 }, (_, index) => {
      const documentId = `concepts/${index}.md`;
      const content = "x".repeat(KNOWLEDGE_VAULT_LIMITS.documentBytes);
      f.sources.set(documentId, content);
      return { documentId, expectedRevision: hash(content) };
    });
    const result = await f.publish({ ...f.input, documents });
    expect(result.documents.map((item) => item.status)).toEqual([
      "published",
      "published",
      "published",
      "published",
      "failed",
      "failed",
      "failed",
    ]);
    expect(f.request).toHaveBeenCalledTimes(5);
    expect(f.selected().documents).toHaveLength(4);
  });
});
