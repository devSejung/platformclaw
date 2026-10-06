import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { compileKnowledgeVaultDocument } from "./knowledge-vault-compiler.js";
import { KNOWLEDGE_VAULT_LIMITS } from "./knowledge-vault-contracts.js";
import { SqliteKnowledgeVaultStore } from "./sqlite-knowledge-vault-store.js";
import { PLATFORMCLAW_CONTROL_SCHEMA_VERSION } from "./sqlite-schema.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "platformclaw-vault-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, "control.sqlite");
  const store = new SqliteControlPlaneStore({
    databasePath,
    initialAdminAccountIds: ["owner"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  cleanup.push(() => store.close());
  const users: Record<string, string> = {};
  for (const accountId of ["owner", "reader", "editor", "outsider"]) {
    const { user } = await store.upsertPrincipal(
      { provider: "ldap", subject: accountId, accountId, employeeId: accountId },
      1,
    );
    users[accountId] = user.id;
  }
  const owner = users.owner!;
  const vault = store.vaults.createVault({ userId: owner, name: "DDRPHY" });
  return {
    store,
    vaults: store.vaults,
    vault,
    owner,
    reader: users.reader!,
    editor: users.editor!,
    outsider: users.outsider!,
    databasePath,
  };
}

describe("Shared Knowledge Vault boundary", () => {
  it("projects authorized accepted links with orphan nodes, stable targets and visible stale revisions", async () => {
    const { vaults, vault, owner, reader, outsider, databasePath } = await fixture();
    vaults.setMember({
      userId: owner,
      vaultId: vault.id,
      memberUserId: reader,
      role: "reader",
    });
    const save = (logicalPath: string, content = "Fact") =>
      vaults.saveDocument({
        userId: owner,
        vaultId: vault.id,
        title: logicalPath,
        logicalPath,
        content,
      });
    const target = save("target.md");
    const orphan = save("orphan.md");
    const source = save("source.md", "[Target](target.md) [[target]] [Missing](missing.md)");
    const privateVault = vaults.createVault({
      userId: owner,
      name: "Private",
    });
    const privateDoc = vaults.saveDocument({
      userId: owner,
      vaultId: privateVault.id,
      title: "Private secret",
      logicalPath: "secret.md",
      content: "Secret",
    });
    const db = new DatabaseSync(databasePath);
    cleanup.push(() => db.close());
    // Even an invalid cross-Vault reference in persisted derived data cannot expose its target.
    db.prepare(
      "INSERT INTO knowledge_vault_links (document_id,target_path,target_document_id) VALUES (?,?,?)",
    ).run(source.id, "foreign.md", privateDoc.id);
    const snapshot = () => vaults.snapshot({ userId: reader, vaultId: vault.id }).selected!;
    expect(snapshot().documents.map((doc) => doc.id)).toContain(orphan.id);
    expect(snapshot().documents.map((doc) => doc.id)).not.toContain(privateDoc.id);
    const publicSource = vaults.readDocument({
      userId: reader,
      vaultId: vault.id,
      documentId: source.id,
    });
    expect(publicSource.links.find((link) => link.logicalPath === "foreign.md")).toEqual({
      target: "foreign.md",
      documentId: null,
      logicalPath: "foreign.md",
      title: "foreign.md",
    });
    expect(JSON.stringify(publicSource)).not.toContain("Private secret");
    expect(snapshot().graph).toEqual({
      edges: [{ source: source.id, target: target.id }],
      unresolvedLinks: 2,
      truncated: false,
    });
    expect(vaults.snapshot({ userId: reader })).not.toHaveProperty("selected");
    expect(() => vaults.snapshot({ userId: outsider, vaultId: vault.id })).toThrow("unavailable");
    expect(() => vaults.snapshot({ userId: reader, vaultId: privateVault.id })).toThrow(
      "unavailable",
    );
    vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      documentId: target.id,
      expectedRevision: 1,
      title: "Moved target",
      logicalPath: "moved/target.md",
      content: target.content,
    });
    save("target.md", "Replacement");
    vaults.rebuild({ userId: owner, vaultId: vault.id, documentId: source.id });
    expect(snapshot().graph).toEqual({
      edges: [{ source: source.id, target: target.id }],
      unresolvedLinks: 1,
      truncated: false,
    });
    const failing = new SqliteKnowledgeVaultStore(db, () => {
      throw new Error("Graph compile failure");
    });
    failing.saveDocument({
      userId: owner,
      vaultId: vault.id,
      documentId: source.id,
      expectedRevision: 1,
      title: "Edited source",
      logicalPath: source.logicalPath,
      content: "[[orphan]]",
    });
    expect(snapshot().graph.edges).toEqual([{ source: source.id, target: target.id }]);
    expect(snapshot().documents.find((doc) => doc.id === source.id)).toMatchObject({
      title: "Edited source",
      revision: 2,
      compile: { status: "failed", indexedRevision: 1 },
    });
    vaults.rebuild({ userId: owner, vaultId: vault.id, documentId: source.id });
    expect(snapshot().graph).toEqual({
      edges: [{ source: source.id, target: orphan.id }],
      unresolvedLinks: 0,
      truncated: false,
    });
    expect(snapshot().documents.find((doc) => doc.id === source.id)?.compile).toMatchObject({
      status: "ready",
      indexedRevision: 2,
    });
    vaults.removeMember({ userId: owner, vaultId: vault.id, memberUserId: reader });
    expect(snapshot).toThrow("unavailable");
  });
  it("bounds a dense graph deterministically without omitting document nodes", async () => {
    const { vaults, vault, owner } = await fixture();
    const docs = Array.from({ length: 46 }, (_, index) =>
      vaults.saveDocument({
        userId: owner,
        vaultId: vault.id,
        title: `Document ${index}`,
        logicalPath: `${index}.md`,
        content: "",
      }),
    );
    for (const doc of docs) {
      vaults.saveDocument({
        userId: owner,
        vaultId: vault.id,
        documentId: doc.id,
        expectedRevision: 1,
        title: doc.title,
        logicalPath: doc.logicalPath,
        content: docs
          .filter((target) => target.id !== doc.id)
          .map((target) => `[[${target.logicalPath}]]`)
          .join("\n"),
      });
    }
    const selected = vaults.snapshot({ userId: owner, vaultId: vault.id }).selected!;
    expect(selected.documents).toHaveLength(docs.length);
    expect(selected.graph).toMatchObject({ unresolvedLinks: 0, truncated: true });
    expect(selected.graph.edges).toHaveLength(KNOWLEDGE_VAULT_LIMITS.graphEdges);
    expect(selected.graph.edges).toEqual(
      vaults.snapshot({ userId: owner, vaultId: vault.id }).selected!.graph.edges,
    );
    expect(
      selected.graph.edges.every(
        (edge) =>
          docs.some((doc) => doc.id === edge.source) && docs.some((doc) => doc.id === edge.target),
      ),
    ).toBe(true);
  });
  it("persists independent connection choices and auto-connects new and imported owned Vaults", async () => {
    const { vaults, vault, owner, reader, databasePath } = await fixture();
    expect(vaults.connectionScope(owner)).toEqual({
      revision: 1,
      vaultIds: [vault.id],
      personalEnabled: true,
    });
    vaults.setMember({
      userId: owner,
      vaultId: vault.id,
      memberUserId: reader,
      role: "reader",
    });
    expect(vaults.connectionScope(reader)).toEqual({
      revision: 1,
      vaultIds: [vault.id],
      personalEnabled: true,
    });
    vaults.setConnection({ userId: reader, vaultId: vault.id, connected: true });
    vaults.setConnection({ userId: reader, vaultId: vault.id, connected: true });
    expect(vaults.connectionScope(reader).revision).toBe(1);
    const db = new DatabaseSync(databasePath);
    try {
      expect(new SqliteKnowledgeVaultStore(db).connectionScope(reader)).toEqual({
        revision: 1,
        vaultIds: [vault.id],
        personalEnabled: true,
      });
    } finally {
      db.close();
    }
    vaults.removeMember({ userId: owner, vaultId: vault.id, memberUserId: reader });
    expect(vaults.connectionScope(reader)).toEqual({
      revision: 2,
      vaultIds: [],
      personalEnabled: true,
    });
    const copy = await vaults.importVault({
      userId: owner,

      archive: await vaults.exportVault({ userId: owner, vaultId: vault.id }),
    });
    expect(vaults.connectionScope(owner).vaultIds).toEqual([vault.id, copy.id].toSorted());
    expect(vaults.connectionScope(owner).revision).toBe(2);
  });
  it("ranks distinct documents across accessible Vaults without letting large documents consume the limit", async () => {
    const { vaults, vault, owner } = await fixture();
    const second = vaults.createVault({
      userId: owner,
      name: "Other project",
    });
    vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "Large",
      logicalPath: "large.md",
      content: "needle ".repeat(100_000),
    });
    const best = vaults.saveDocument({
      userId: owner,
      vaultId: second.id,
      title: "needle",
      logicalPath: "best.md",
      content: "needle fact",
    });
    const hits = vaults.search({ userId: owner, query: "needle", maxResults: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.documentId).toBe(best.id);
    expect(vaults.search({ userId: owner, query: "needle", vaultId: vault.id })).toHaveLength(1);
  });
  it("matches every Unicode token across title, chunks, path and ID with deterministic ranking", async () => {
    const { vaults, vault, owner, outsider } = await fixture();
    const doc = vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "LPDDR Training",
      logicalPath: "specs/전압/calibration.md",
      content: `timing ${"padding ".repeat(400)}voltage margin`,
    });
    vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "Partial",
      logicalPath: "partial.md",
      content: "voltage only",
    });
    for (const query of ["voltage timing", "margin LPDDR", "전압 calibration voltage", doc.id]) {
      expect(vaults.search({ userId: owner, query })).toEqual([
        expect.objectContaining({ documentId: doc.id }),
      ]);
    }
    expect(vaults.search({ userId: owner, query: "voltage margin" })[0]!.snippet).toContain(
      "voltage margin",
    );
    expect(vaults.search({ userId: owner, query: "voltage missing" })).toEqual([]);
    expect(vaults.search({ userId: outsider, query: doc.id })).toEqual([]);
    expect(() =>
      vaults.search({
        userId: owner,
        query: Array.from({ length: 17 }, (_, i) => `word${i}`).join(" "),
      }),
    ).toThrow("1-16");
  });
  it("enforces membership, roles, role-based export permission and last active Owner", async () => {
    const { vaults, vault, owner, reader, editor, outsider, databasePath } = await fixture();
    vaults.setMember({
      userId: owner,
      vaultId: vault.id,
      accountId: "reader",
      role: "reader",
    });
    vaults.setMember({
      userId: owner,
      vaultId: vault.id,
      memberUserId: editor,
      role: "editor",
    });
    const doc = vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "Training",
      logicalPath: "training.md",
      content: "LPDDR training facts",
    });
    expect(vaults.search({ userId: reader, query: "LPDDR" })).toEqual([
      expect.objectContaining({
        vaultId: vault.id,
        vaultName: "DDRPHY",
        vaultType: "shared",
        documentId: doc.id,
        title: "Training",
        path: `shared/${vault.id}/${doc.id}`,
        revision: 1,
      }),
    ]);
    expect(vaults.search({ userId: outsider, query: "LPDDR" })).toEqual([]);
    expect(() =>
      vaults.readDocument({ userId: outsider, vaultId: vault.id, documentId: doc.id }),
    ).toThrow(/unavailable/u);
    expect(() => vaults.search({ userId: outsider, query: "LPDDR", vaultId: vault.id })).toThrow(
      /unavailable/u,
    );
    expect(() =>
      vaults.saveDocument({
        userId: reader,
        vaultId: vault.id,
        title: "No",
        logicalPath: "no.md",
        content: "no",
      }),
    ).toThrow(/unavailable/u);
    await expect(vaults.exportVault({ userId: reader, vaultId: vault.id })).rejects.toThrow(
      /unavailable/u,
    );
    expect(() =>
      vaults.setMember({
        userId: editor,
        vaultId: vault.id,
        memberUserId: outsider,
        role: "reader",
      }),
    ).toThrow(/unavailable/u);
    expect(() =>
      vaults.removeMember({ userId: owner, vaultId: vault.id, memberUserId: owner }),
    ).toThrow(/last effective Owner/u);
    vaults.setMember({
      userId: owner,
      vaultId: vault.id,
      memberUserId: reader,
      role: "reader",
    });
    expect(
      (await vaults.exportVault({ userId: editor, vaultId: vault.id })).length,
    ).toBeGreaterThan(0);
    vaults.removeMember({ userId: owner, vaultId: vault.id, memberUserId: reader });
    expect(vaults.search({ userId: reader, query: "LPDDR" })).toEqual([]);
    const db = new DatabaseSync(databasePath);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
      });
    } finally {
      db.close();
    }
  });

  it("preserves source bytes, detects stale saves and keeps links stable through moves and rebuilds", async () => {
    const { vaults, vault, owner } = await fixture();
    const target = vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "PHY",
      logicalPath: "phy.md",
      content: "Target",
    });
    const original =
      "\ufeff# Controller\r\n\r\nSee [PHY](phy.md).  \r\nLiteral malformed [%](bad%xx.md).\r\n";
    const doc = vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "Controller",
      logicalPath: "controller.md",
      content: original,
    });
    expect(doc.content).toBe(original);
    expect(doc.links).toEqual([
      { target: "bad%xx.md", documentId: null, logicalPath: "bad%xx.md", title: "bad%xx.md" },
      expect.objectContaining({ documentId: target.id }),
    ]);
    vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      documentId: target.id,
      expectedRevision: 1,
      title: "PHY",
      logicalPath: "spec/phy.md",
      content: "Target",
    });
    vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "Other PHY",
      logicalPath: "phy.md",
      content: "Other",
    });
    vaults.rebuild({ userId: owner, vaultId: vault.id });
    const read = vaults.readDocument({ userId: owner, vaultId: vault.id, documentId: doc.id });
    expect(read.content).toBe(original);
    expect(read.links).toEqual([
      { target: "bad%xx.md", documentId: null, logicalPath: "bad%xx.md", title: "bad%xx.md" },
      expect.objectContaining({ documentId: target.id, logicalPath: "spec/phy.md" }),
    ]);
    expect(
      vaults.readDocument({ userId: owner, vaultId: vault.id, documentId: target.id }).backlinks,
    ).toEqual([expect.objectContaining({ documentId: doc.id })]);
    expect(() =>
      vaults.saveDocument({
        userId: owner,
        vaultId: vault.id,
        documentId: doc.id,
        expectedRevision: 0,
        title: "Stale",
        logicalPath: "controller.md",
        content: "bad",
      }),
    ).toThrow(/reload/u);
    expect(() =>
      vaults.saveDocument({
        userId: owner,
        vaultId: vault.id,
        title: "Collision",
        logicalPath: "controller.md",
        content: "bad",
      }),
    ).toThrow(/already exists/u);
  });

  it("resolves exact shorthand paths before and after their target is created", async () => {
    const { vaults, vault, owner } = await fixture();
    const source = vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "Source",
      logicalPath: "notes/source.md",
      content:
        "[[training]] [nested](../spec/timing)\n`[[example]]`\n```md\n[fenced](../fake.md)\n```",
    });
    expect(source.links.every((link) => link.documentId === null)).toBe(true);
    expect(source.links).toHaveLength(2);
    const target = vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "Different title",
      logicalPath: "training.md",
      content: "Fact",
    });
    const nested = vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "Nested",
      logicalPath: "spec/timing.md",
      content: "Fact",
    });
    const read = () =>
      vaults.readDocument({ userId: owner, vaultId: vault.id, documentId: source.id });
    expect(new Set(read().links.map((link) => link.documentId))).toEqual(
      new Set([target.id, nested.id]),
    );
    vaults.rebuild({ userId: owner, vaultId: vault.id, documentId: source.id });
    expect(new Set(read().links.map((link) => link.documentId))).toEqual(
      new Set([target.id, nested.id]),
    );
    expect(read().content).toBe(source.content);
  });
  it("keeps explicit root links distinct from shorthand titles and IDs through rebuilds", async () => {
    const { vaults, vault, owner } = await fixture();
    const save = (logicalPath: string, title: string, content = "Fact") =>
      vaults.saveDocument({ userId: owner, vaultId: vault.id, logicalPath, title, content });
    const target = save("spec/target.md", "Target");
    const titled = save("spec/other.md", "missing.md");
    const source = save(
      "notes/source.md",
      "Source",
      `[relative](../spec/target.md#details) [root](/spec/target.md#details) [[/spec/target.md]] [missing](/missing.md) [[missing.md]] [[/${target.id}]]`,
    );
    const expected = [
      expect.objectContaining({ target: "spec/target.md", documentId: target.id }),
      expect.objectContaining({ target: "/spec/target.md", documentId: target.id }),
      expect.objectContaining({ target: "/missing.md", documentId: null }),
      expect.objectContaining({ target: "missing.md", documentId: titled.id }),
      expect.objectContaining({ target: `/${target.id}`, documentId: null }),
    ];
    expect(source.links).toHaveLength(expected.length);
    expect(source.links).toEqual(expect.arrayContaining(expected));
    vaults.rebuild({ userId: owner, vaultId: vault.id, documentId: source.id });
    const read = vaults.readDocument({ userId: owner, vaultId: vault.id, documentId: source.id });
    expect(read.links).toHaveLength(expected.length);
    expect(read.links).toEqual(expect.arrayContaining(expected));
    expect(read.content).toBe(source.content);
  });
  it("retains last-good search on compiler failure and retries after reopening", async () => {
    const { vaults, vault, owner, databasePath } = await fixture();
    const doc = vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "Old title",
      logicalPath: "notes.md",
      content: "known-good searchable",
    });
    const db = new DatabaseSync(databasePath);
    let connectionOpen = true;
    cleanup.push(() => {
      if (connectionOpen) {
        db.close();
      }
    });
    const failing = new SqliteKnowledgeVaultStore(db, () => {
      throw new Error("Injected compiler failure");
    });
    const saved = failing.saveDocument({
      userId: owner,
      vaultId: vault.id,
      documentId: doc.id,
      expectedRevision: 1,
      title: "New title",
      logicalPath: "notes.md",
      content: "new source retained",
    });
    expect(saved).toMatchObject({
      content: "new source retained",
      revision: 2,
      compile: {
        status: "failed",
        indexedRevision: 1,
        error: "Injected compiler failure",
        attempts: 1,
      },
    });
    expect(failing.search({ userId: owner, query: "known-good" })).toEqual([
      expect.objectContaining({
        title: "Old title",
        revision: 1,
        snippet: "known-good searchable",
        indexStatus: "failed",
        indexError: "Injected compiler failure",
        nextRetryAt: saved.compile.retryAt,
      }),
    ]);
    expect(failing.search({ userId: owner, query: "new source" })).toEqual([]);
    db.close();
    connectionOpen = false;
    const reopenedDb = new DatabaseSync(databasePath);
    cleanup.push(() => reopenedDb.close());
    const recovered = new SqliteKnowledgeVaultStore(reopenedDb, compileKnowledgeVaultDocument);
    expect(recovered.search({ userId: owner, query: "known-good" })[0]).toMatchObject({
      revision: 1,
      indexStatus: "failed",
    });
    recovered.retryFailed(saved.compile.retryAt!);
    expect(
      recovered.readDocument({ userId: owner, vaultId: vault.id, documentId: doc.id }).compile,
    ).toMatchObject({ status: "ready", indexedRevision: 2, error: null });
    expect(recovered.search({ userId: owner, query: "new source" })).toEqual([
      expect.objectContaining({ revision: 2 }),
    ]);
    expect(recovered.search({ userId: owner, query: "known-good" })).toEqual([]);
  });

  it("exports originals and attachments without indexes, imports atomically to a new sole-owner Vault", async () => {
    const { vaults, vault, owner, reader } = await fixture();
    const content = "\ufeff# LPDDR\r\nSource  \r\n";
    vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "LPDDR",
      logicalPath: "spec/lpddr.md",
      content,
    });
    vaults.uploadAttachment({
      userId: owner,
      vaultId: vault.id,
      path: "waveforms/data.bin",
      mediaType: "application/octet-stream",
      content: Buffer.from([0, 1, 2, 255]),
    });
    const archive = await vaults.exportVault({ userId: owner, vaultId: vault.id });
    const zip = await JSZip.loadAsync(archive);
    expect(Object.keys(zip.files).toSorted()).toEqual([
      "attachments/waveforms/data.bin",
      "documents/spec/lpddr.md",
      "vault.json",
    ]);
    expect(await zip.file("documents/spec/lpddr.md")!.async("nodebuffer")).toEqual(
      Buffer.from(content),
    );
    const imported = await vaults.importVault({ userId: reader, archive });
    expect(imported.id).not.toBe(vault.id);
    const snapshot = vaults.snapshot({ userId: reader, vaultId: imported.id }).selected!;
    expect(snapshot.members).toEqual([expect.objectContaining({ userId: reader, role: "owner" })]);
    expect(snapshot.documents[0]!.compile.status).toBe("ready");
    expect(
      vaults.readDocument({
        userId: reader,
        vaultId: imported.id,
        documentId: snapshot.documents[0]!.id,
      }).content,
    ).toBe(content);
    expect(
      vaults.downloadAttachment({
        userId: reader,
        vaultId: imported.id,
        path: "waveforms/data.bin",
      }).content,
    ).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(vaults.listVaults(owner).filter((item) => item.canRead)).toHaveLength(1);
    const maliciousMetadata = JSON.parse(await zip.file("vault.json")!.async("string"));
    maliciousMetadata.attachments[0].mediaType = "text/plain\r\nX-Injected: value";
    zip.file("vault.json", JSON.stringify(maliciousMetadata));
    await expect(
      vaults.importVault({
        userId: reader,
        archive: await zip.generateAsync({ type: "nodebuffer" }),
      }),
    ).rejects.toThrow(/MIME/u);
    expect(vaults.listVaults(reader).filter((item) => item.canRead)).toHaveLength(1);
    expect(() =>
      vaults.uploadAttachment({
        userId: owner,
        vaultId: vault.id,
        path: "invalid.bin",
        mediaType: "text/plain\r\nX-Injected: value",
        content: Buffer.from("bad"),
      }),
    ).toThrow(/MIME/u);
    const hostile = new JSZip();
    hostile.file("../vault.json", "{}");
    await expect(
      vaults.importVault({
        userId: reader,
        archive: await hostile.generateAsync({ type: "nodebuffer" }),
      }),
    ).rejects.toThrow();
    expect(vaults.listVaults(reader).filter((item) => item.canRead)).toHaveLength(1);
  });

  it("uses revision CAS for attachment replacement/delete and owner-gates vault rename/delete", async () => {
    const { vaults, vault, owner, reader } = await fixture();
    vaults.setMember({ userId: owner, vaultId: vault.id, memberUserId: reader, role: "reader" });
    vaults.setConnection({ userId: reader, vaultId: vault.id, connected: true });
    const selectionBefore = vaults.connectionScope(reader).revision;

    vaults.uploadAttachment({
      userId: owner,
      vaultId: vault.id,
      path: "capture.bin",
      mediaType: "application/octet-stream",
      content: Buffer.from("one"),
    });
    const first = vaults.downloadAttachment({
      userId: reader,
      vaultId: vault.id,
      path: "capture.bin",
    });
    expect(first.revision).toBe(1);
    expect(() =>
      vaults.uploadAttachment({
        userId: owner,
        vaultId: vault.id,
        path: "capture.bin",
        mediaType: "application/octet-stream",
        content: Buffer.from("stale"),
      }),
    ).toThrow(/reload before replacing/u);
    vaults.uploadAttachment({
      userId: owner,
      vaultId: vault.id,
      path: "capture.bin",
      mediaType: "application/octet-stream",
      content: Buffer.from("two"),
      expectedRevision: 1,
    });
    expect(() =>
      vaults.deleteAttachment({
        userId: owner,
        vaultId: vault.id,
        path: "capture.bin",
        expectedRevision: 1,
      }),
    ).toThrow(/reload before deleting/u);
    expect(
      vaults.deleteAttachment({
        userId: owner,
        vaultId: vault.id,
        path: "capture.bin",
        expectedRevision: 2,
      }),
    ).toEqual({ deleted: true, path: "capture.bin" });
    expect(() =>
      vaults.uploadAttachment({
        userId: owner,
        vaultId: vault.id,
        path: "capture.bin",
        mediaType: "application/octet-stream",
        content: Buffer.from("stale-after-delete"),
        expectedRevision: 2,
      }),
    ).toThrow(/reload before replacing/u);
    vaults.uploadAttachment({
      userId: owner,
      vaultId: vault.id,
      path: "capture.bin",
      mediaType: "application/octet-stream",
      content: Buffer.from("three"),
    });
    const recreated = vaults.downloadAttachment({
      userId: owner,
      vaultId: vault.id,
      path: "capture.bin",
    });
    expect(recreated.revision).toBe(3);
    expect(() =>
      vaults.deleteAttachment({
        userId: owner,
        vaultId: vault.id,
        path: "capture.bin",
        expectedRevision: 2,
      }),
    ).toThrow(/reload before deleting/u);

    expect(() => vaults.renameVault({ userId: reader, vaultId: vault.id, name: "Nope" })).toThrow(
      /unavailable/u,
    );
    expect(vaults.renameVault({ userId: owner, vaultId: vault.id, name: "Renamed" }).name).toBe(
      "Renamed",
    );
    expect(() => vaults.deleteVault({ userId: reader, vaultId: vault.id })).toThrow(/unavailable/u);
    expect(vaults.deleteVault({ userId: owner, vaultId: vault.id })).toEqual({
      deleted: true,
      vaultId: vault.id,
    });
    expect(vaults.connectionScope(reader)).toMatchObject({
      revision: selectionBefore + 1,
      vaultIds: [],
    });
    expect(vaults.listVaults(owner).some((item) => item.id === vault.id)).toBe(false);
  });
});
