import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserGatewayRpc } from "./browser-gateway-contracts.js";
import type { KnowledgeVaultDocumentImportResult } from "./knowledge-vault-contracts.js";
import { KnowledgeVaultService } from "./knowledge-vault-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
});
async function fixture(saved = true) {
  const root = mkdtempSync(join(tmpdir(), "wiki-personal-adapter-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteControlPlaneStore({
    databasePath: join(root, "control.sqlite"),
    initialAdminAccountIds: ["employee"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  cleanup.push(() => store.close());
  const { user } = await store.upsertPrincipal(
    { provider: "ldap", subject: "employee", accountId: "employee", employeeId: "employee" },
    1,
  );
  const reserved = await store.reservePersonalAgent(user.id, 2);
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: 3,
  });
  const path = "concepts/Training.md";
  const source = "\uFEFF---\r\ntitle: Training\r\ncustom: keep\r\n---\r\n# Body\r\n";
  const revision = createHash("sha256").update(source).digest("hex");
  const files = [
    { path, kind: "document", size: Buffer.byteLength(source), revision, title: "Training" },
    { path: "_attachments/design.bin", kind: "attachment", size: 3, revision: "b".repeat(64) },
  ];
  const item = {
    pagePath: path,
    title: "Training",
    kind: "concept",
    claimCount: 1,
    questionCount: 1,
    contradictionCount: 0,
    claims: ["Known fact"],
    questions: ["Open question"],
    contradictions: [],
    snippet: "Body preview",
    updatedAt: "2026-09-29T00:00:00Z",
  };
  const request = vi.fn<BrowserGatewayRpc["request"]>(async (method, params) => {
    if (!isRecord(params)) {
      throw new Error("Missing fixture RPC params");
    }
    expect(params?.agentId).toBe(binding.agentId);
    if (method === "wiki.document.get") {
      return {
        path,
        title: "Training",
        kind: "concept",
        sourceContent: source,
        displayContent: "# Body\n",
        editableContent: "# Body\r\n",
        editMode: "body",
        links: [
          { target: "Training title", documentId: path, logicalPath: path, title: "Training" },
        ],
        linksTruncated: false,
        revision,
      };
    }
    if (method === "wiki.overview") {
      return {
        totalItems: 1,
        totalPages: 1,
        pageCounts: { entity: 0, concept: 1, source: 0, synthesis: 0, report: 0 },
        totalClaims: 1,
        totalQuestions: 1,
        totalContradictions: 0,
        documents: [item],
        documentsTruncated: false,
        clusters: [
          {
            key: "concept",
            label: "Concepts",
            itemCount: 1,
            claimCount: 1,
            questionCount: 1,
            contradictionCount: 0,
            items: [item],
          },
        ],
      };
    }
    if (method === "wiki.graph") {
      return {
        nodes: [{ id: path, title: "Training", kind: "concept" }],
        edges: [],
        stats: {
          totalPages: 1,
          totalNodes: 1,
          totalEdges: 0,
          unresolvedLinks: 1,
          truncated: false,
        },
      };
    }
    if (method === "wiki.archive.manifest") {
      return { entries: params?.kind === "attachment" ? [files[1]] : files, truncated: false };
    }
    if (method === "wiki.archive.read") {
      const file = files.find((entry) => entry.path === params?.path)!;
      return {
        path: file.path,
        revision: file.revision,
        totalBytes: file.size,
        contentBase64: (file.kind === "document"
          ? Buffer.from(source)
          : Buffer.from([0, 1, 2])
        ).toString("base64"),
        nextOffset: null,
      };
    }
    if (method === "wiki.document.create") {
      return { saved: true, path, title: "Training", revision, indexesRefreshed: true };
    }
    if (method === "wiki.document.save") {
      return { saved, path, revision, indexesRefreshed: true };
    }
    if (method === "wiki.delete") {
      return { agentId: binding.agentId, path, deleted: true, indexesRefreshed: true };
    }
    if (method === "wiki.attachment.put") {
      return { path: "_attachments/new.bin", revision: "c".repeat(64), size: 3 };
    }
    if (method === "wiki.attachment.delete") {
      return { path: "_attachments/design.bin", deleted: true };
    }
    throw new Error(`Unexpected ${method}`);
  });
  const service = new KnowledgeVaultService(store, { request });
  return {
    service,
    store,
    user,
    binding,
    path,
    source,
    revision,
    request,
    vaultId: `personal:${binding.agentId}`,
  };
}
describe("Personal Wiki common adapter", () => {
  it("lists a thousand documents independently of the graph and still opens omitted sources", async () => {
    const f = await fixture();
    const original = f.request.getMockImplementation()!;
    const documents = Array.from({ length: 1000 }, (_, index) => ({
      pagePath: `concepts/note-${String(index).padStart(4, "0")}.md`,
      title: `Note ${index}`,
      kind: "concept",
      claimCount: 0,
      questionCount: 0,
      contradictionCount: 0,
      claims: [],
      questions: [],
      contradictions: [],
      snippet: "Imported source",
    }));
    const overview = {
      totalPages: 1001,
      totalItems: 1001,
      pageCounts: { entity: 0, concept: 1001, source: 0, synthesis: 0, report: 0 },
      totalClaims: 0,
      totalQuestions: 0,
      totalContradictions: 0,
      documents,
      documentsTruncated: true,
      clusters: [
        {
          key: "concept",
          label: "Concepts",
          itemCount: 1001,
          claimCount: 0,
          questionCount: 0,
          contradictionCount: 0,
          items: documents.slice(0, 500),
        },
      ],
    };
    f.request.mockImplementation(async (method, params) => {
      if (method === "wiki.overview") {
        return overview;
      }
      if (method === "wiki.graph") {
        return {
          nodes: [
            { id: "index.md", title: "Wiki Index", kind: "index" },
            ...documents
              .slice(0, 494)
              .map((item) => ({ id: item.pagePath, title: item.title, kind: item.kind })),
          ],
          edges: [
            { source: "index.md", target: documents[0]!.pagePath, type: "membership" },
            { source: documents[0]!.pagePath, target: documents[1]!.pagePath, type: "reference" },
          ],
          stats: {
            totalPages: 1001,
            totalNodes: 495,
            totalEdges: 2,
            unresolvedLinks: 0,
            truncated: true,
          },
        };
      }
      return original(method, params);
    });
    const snapshot = await f.service.snapshot({ userId: f.user.id, vaultId: f.vaultId });
    expect(snapshot.vaults[0]!.documentCount).toBe(1001);
    expect(snapshot.selected).toMatchObject({ documentCount: 1001, documentsTruncated: true });
    expect(snapshot.selected!.documents).toHaveLength(1000);
    expect(snapshot.selected!.documents.at(-1)!.logicalPath).toBe(documents.at(-1)!.pagePath);
    expect(snapshot.selected!.graph.nodeIds).toHaveLength(494);
    expect(snapshot.selected!.graph.edges).toEqual([
      { source: documents[0]!.pagePath, target: documents[1]!.pagePath },
    ]);
    await expect(
      f.service.readDocument({ userId: f.user.id, vaultId: f.vaultId, documentId: f.path }),
    ).resolves.toMatchObject({ id: f.path, sourceContent: f.source });
    for (const invalid of [
      { ...overview, documents: [...documents, documents[0]] },
      { ...overview, documents: [documents[0], documents[0]] },
      { ...overview, documentsTruncated: false },
    ]) {
      f.request.mockImplementation(async (method, params) =>
        method === "wiki.overview" ? invalid : original(method, params),
      );
      await expect(
        f.service.snapshot({ userId: f.user.id, vaultId: f.vaultId }),
      ).rejects.toMatchObject({ code: "upstream-result-denied" });
    }
  });

  it("keeps batch source bytes, order, identity and partial outcomes without per-file reloads", async () => {
    const f = await fixture();
    const importId = "b9314df9-8828-4eee-9231-9667bf4c0f36";
    const rootPath = `concepts/imports/${importId}`;
    const documents = [
      { relativePath: "Spec/A.MD", content: f.source },
      { relativePath: "Spec/B.markdown", content: "# B\n[A](A.MD)\n" },
      { relativePath: "Spec/C.md", content: "# C\n" },
    ];
    const result: KnowledgeVaultDocumentImportResult = {
      importId,
      rootPath,
      documents: [
        {
          relativePath: "Spec/A.MD",
          path: `${rootPath}/Spec/A.md`,
          title: "Training",
          status: "saved",
          revision: f.revision,
        },
        {
          relativePath: "Spec/B.markdown",
          path: `${rootPath}/Spec/B.md`,
          title: "B",
          status: "unchanged",
          revision: createHash("sha256").update(documents[1]!.content).digest("hex"),
        },
        {
          relativePath: "Spec/C.md",
          path: `${rootPath}/Spec/C.md`,
          status: "failed",
          error: "conflict",
        },
      ],
      indexesRefreshed: false,
    };
    f.request.mockResolvedValueOnce(result);
    await expect(
      f.service.importDocuments({ userId: f.user.id, vaultId: f.vaultId, importId, documents }),
    ).resolves.toEqual(result);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("wiki.document.import", {
      agentId: f.binding.agentId,
      importId,
      documents,
    });
  });
  it.each(["foreign-path", "changed-source", "missing-outcome", "invalid-failure"])(
    "rejects an untrusted batch response: %s",
    async (failure) => {
      const f = await fixture();
      const importId = "b9314df9-8828-4eee-9231-9667bf4c0f36";
      const rootPath = `concepts/imports/${importId}`;
      const outcome: Record<string, unknown> = {
        relativePath: "A.md",
        path: `${rootPath}/A.md`,
        title: "Training",
        status: "saved",
        revision: f.revision,
      };
      if (failure === "foreign-path") {
        outcome.path = "concepts/other.md";
      }
      if (failure === "changed-source") {
        outcome.revision = "f".repeat(64);
      }
      if (failure === "invalid-failure") {
        outcome.status = "failed";
        outcome.error = "internal path detail";
      }
      f.request.mockResolvedValueOnce({
        importId,
        rootPath,
        documents: failure === "missing-outcome" ? [] : [outcome],
        indexesRefreshed: true,
      });
      await expect(
        f.service.importDocuments({
          userId: f.user.id,
          vaultId: f.vaultId,
          importId,
          documents: [{ relativePath: "A.md", content: f.source }],
        }),
      ).rejects.toMatchObject({ code: "upstream-result-denied" });
    },
  );
  it("rejects foreign Personal identity and oversized batches before contacting the owner", async () => {
    const f = await fixture();
    const input = {
      userId: f.user.id,
      vaultId: f.vaultId,
      importId: "b9314df9-8828-4eee-9231-9667bf4c0f36",
      documents: [{ relativePath: "A.md", content: f.source }],
    };
    await expect(
      f.service.importDocuments({ ...input, vaultId: "personal:other" }),
    ).rejects.toThrow("unavailable");
    await expect(
      f.service.importDocuments({
        ...input,
        documents: [{ relativePath: "A.md", content: "가".repeat(400_000) }],
      }),
    ).rejects.toThrow("1 MiB");
    await expect(
      f.service.importDocuments({
        ...input,
        documents: Array.from({ length: 5 }, (_, index) => ({
          relativePath: `${index}.md`,
          content: "a".repeat(1024 * 1024),
        })),
      }),
    ).rejects.toThrow("4 MiB");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("accepts the source owner's unchanged-save outcome and returns the current revision", async () => {
    const f = await fixture(false);
    await expect(
      f.service.saveDocument({
        userId: f.user.id,
        vaultId: f.vaultId,
        documentId: f.path,
        expectedRevision: f.revision,
        content: "# Body\r\n",
      }),
    ).resolves.toMatchObject({ revision: f.revision, sourceContent: f.source });
  });
  it("uses authenticated binding, retains raw source/revision/metadata, and rejects forged ids", async () => {
    const f = await fixture();
    const snapshot = await f.service.snapshot({ userId: f.user.id, vaultId: f.vaultId });
    expect(snapshot.selected!.vault).toMatchObject({
      type: "personal",
      role: "owner",
      canRead: true,
      canEdit: true,
      canExport: true,
    });
    expect(snapshot.selected!.graph.unresolvedLinks).toBe(1);
    expect(snapshot.selected!.documents[0]).toMatchObject({
      snippet: "Body preview",
      link: "[[concepts/Training.md|Training]]",
    });
    await expect(
      f.service.documentTargets({ userId: f.user.id, vaultId: f.vaultId, query: "Training" }),
    ).resolves.toEqual({
      items: [
        {
          documentId: f.path,
          title: "Training",
          logicalPath: f.path,
          link: "[[/concepts/Training.md|Training]]",
        },
      ],
      hasMore: false,
    });
    const doc = await f.service.readDocument({
      userId: f.user.id,
      vaultId: f.vaultId,
      documentId: f.path,
    });
    expect(doc).toMatchObject({
      sourceContent: f.source,
      editableContent: "# Body\r\n",
      revision: f.revision,
      metadata: { claims: ["Known fact"], questions: ["Open question"] },
    });
    await expect(
      f.service.snapshot({ userId: f.user.id, vaultId: "personal:other" }),
    ).rejects.toThrow("unavailable");
    f.request.mockClear();
    await expect(
      f.service.publish({
        userId: f.user.id,
        agentId: "other",
        lookup: f.path,
        targetVaultId: "nope",
        expectedRevision: f.revision,
      }),
    ).rejects.toThrow("unavailable");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("forwards filename/title source decisions, guarded body saves and hash-checked deletion", async () => {
    const f = await fixture();
    await f.service.saveDocument({
      userId: f.user.id,
      vaultId: f.vaultId,
      filename: "Training.markdown",
      title: "Training",
      content: f.source,
    });
    expect(f.request).toHaveBeenCalledWith("wiki.document.create", {
      agentId: f.binding.agentId,
      filename: "Training.markdown",
      title: "Training",
      content: f.source,
    });
    await f.service.saveDocument({
      userId: f.user.id,
      vaultId: f.vaultId,
      documentId: f.path,
      expectedRevision: f.revision,
      title: "Renamed",
      content: "New body",
    });
    expect(f.request).toHaveBeenCalledWith("wiki.document.save", {
      agentId: f.binding.agentId,
      path: f.path,
      editMode: "body",
      expectedRevision: f.revision,
      title: "Renamed",
      content: "New body",
    });
    await f.service.deleteDocument({
      userId: f.user.id,
      vaultId: f.vaultId,
      documentId: f.path,
      expectedRevision: f.revision,
    });
    expect(f.request).toHaveBeenCalledWith("wiki.delete", {
      agentId: f.binding.agentId,
      path: f.path,
      expectedContentHash: f.revision,
    });
  });
  it.each([true, false])(
    "retains source-owner deletion outcome when indexesRefreshed is %s",
    async (indexesRefreshed) => {
      const f = await fixture();
      f.request.mockResolvedValueOnce({
        agentId: f.binding.agentId,
        path: f.path,
        deleted: true,
        indexesRefreshed,
      });
      await expect(
        f.service.deleteDocument({
          userId: f.user.id,
          vaultId: f.vaultId,
          documentId: f.path,
          expectedRevision: f.revision,
        }),
      ).resolves.toEqual({ deleted: true, documentId: f.path, indexesRefreshed });
    },
  );
  it("exports original Markdown and binary attachments in importable ZIP, while enabled choice persists", async () => {
    const f = await fixture();
    const zip = await JSZip.loadAsync(
      await f.service.exportVault({ userId: f.user.id, vaultId: f.vaultId }),
    );
    expect(await zip.file(`documents/${f.path}`)!.async("nodebuffer")).toEqual(
      Buffer.from(f.source),
    );
    expect(await zip.file("attachments/_attachments/design.bin")!.async("nodebuffer")).toEqual(
      Buffer.from([0, 1, 2]),
    );
    expect(Object.keys(zip.files)).not.toContain("index.md");
    await f.service.setConnection({ userId: f.user.id, vaultId: f.vaultId, connected: false });
    expect(f.service.captureScope({ agentId: f.binding.agentId }).personalEnabled).toBe(false);
    await f.store.upsertPrincipal(
      { provider: "ldap", subject: "employee", accountId: "employee", employeeId: "employee" },
      10,
    );
    expect((await f.service.snapshot({ userId: f.user.id })).vaults[0]!.connected).toBe(false);
    const copied = await f.store.vaults.importVault({
      userId: f.user.id,
      archive: await f.service.exportVault({ userId: f.user.id, vaultId: f.vaultId }),
    });
    expect(copied.type).toBe("shared");
  });
  it("deletes a Personal attachment through its revision-pinned artifact path", async () => {
    const f = await fixture();
    const expectedRevision = "b".repeat(64);
    await expect(
      f.service.deleteAttachment({
        userId: f.user.id,
        vaultId: f.vaultId,
        path: "_attachments/design.bin",
        expectedRevision,
      }),
    ).resolves.toEqual({ path: "_attachments/design.bin", deleted: true });
    expect(f.request).toHaveBeenCalledWith("wiki.attachment.delete", {
      agentId: f.binding.agentId,
      path: "_attachments/design.bin",
      expectedRevision,
    });
  });
});
