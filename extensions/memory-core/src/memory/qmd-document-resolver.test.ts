import path from "node:path";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { QmdDocumentResolver } from "./qmd-document-resolver.js";

describe("QMD indexed source versions", () => {
  it("resolves exact, abbreviated, and slugified hints to the indexed content hash", async () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    try {
      // QMD's documents.hash is the NOT NULL content-addressed source version.
      db.exec(
        "CREATE TABLE documents (collection TEXT, path TEXT, hash TEXT NOT NULL, modified_at TEXT, active INTEGER)",
      );
      const hash = "abcdef" + "1".repeat(58);
      db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, 1)").run(
        "notes",
        "Design Notes.md",
        hash,
        "2026-07-01T00:00:00Z",
      );
      const root = path.resolve("qmd-version-fixture");
      const resolver = new QmdDocumentResolver(
        root,
        new Map([["notes", { path: root, kind: "memory" }]]),
        () => db,
        false,
      );
      for (const [docid, hints] of [
        [hash, undefined],
        ["#abcdef", undefined],
        [undefined, { preferredCollection: "notes", preferredFile: "Design Notes.md" }],
        [undefined, { preferredFile: "qmd://notes/design-notes.md" }],
      ] as const) {
        await expect(resolver.resolveDocLocation(docid, hints)).resolves.toMatchObject({
          sourceVersion: hash,
          rel: "Design Notes.md",
        });
      }
      await expect(
        resolver.resolveDocLocation(undefined, {
          preferredCollection: "notes",
          preferredFile: "missing.md",
        }),
      ).rejects.toThrow("Run qmd update");
      db.exec("DROP TABLE documents");
      await expect(
        resolver.resolveDocLocation(undefined, {
          preferredCollection: "notes",
          preferredFile: "Design Notes.md",
        }),
      ).rejects.toThrow("Run qmd update");
    } finally {
      db.close();
    }
  });
});
