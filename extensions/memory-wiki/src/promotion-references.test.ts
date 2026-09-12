import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { memoryWikiPromotionRevision, memoryWikiReferenceTextHash } from "../reference-api.js";
import { applyMemoryWikiMutation } from "./apply.js";
import { resolveMemoryWikiPromotionReferences } from "./promotion-references.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { listMemoryWikiGraph } from "./wiki-graph.js";

const { createVault } = createMemoryWikiTestHarness();
describe("native personal promotion references", () => {
  it("runs the actual search, inspect, apply synthesis, compile, and graph tool-owner sequence", async () => {
    const { config, rootDir } = await createVault({ initialize: true });
    const personal = {
      ...config,
      agentId: "main",
      vault: { ...config.vault, scope: "agent" as const },
    };
    await fs.writeFile(
      path.join(rootDir, "concepts/connection.md"),
      "---\nid: concept.connection\npageType: concept\ntitle: 가상 연결 진단\n---\n# 가상 연결 진단\n가상 연결은 상태 확인과 조건 기록으로 진단한다.\n",
    );
    const hits = await searchMemoryWiki({
      config: personal,
      query: "가상 연결",
      searchCorpus: "wiki",
      searchBackend: "local",
      maxResults: 5,
    });
    const hit = hits.find((candidate) => candidate.path === "concepts/connection.md")!;
    expect(hit).toBeDefined();
    const inspected = await getMemoryWikiPage({
      config: personal,
      lookup: hit.path,
      searchCorpus: "wiki",
      searchBackend: "local",
    });
    expect(inspected!.content).toContain("상태 확인과 조건 기록");
    const filed = await applyMemoryWikiMutation({
      config: personal,
      mutation: {
        op: "create_synthesis",
        title: "가상 확인 절차",
        sourceIds: [inspected!.id!],
        body: `확인한 진단 순서를 따른다. [[${hit.path}|가상 연결 진단]]`,
        claims: [{ text: "상태와 조건을 기록한다.", sourceIds: [inspected!.id!] }],
      },
    });
    expect(filed.changed).toBe(true);
    const read = await getMemoryWikiPage({
      config: personal,
      lookup: filed.pagePath,
      searchCorpus: "wiki",
      searchBackend: "local",
    });
    expect(read!.content).toContain(`[[${hit.path}|가상 연결 진단]]`);
    expect((await listMemoryWikiGraph(personal)).edges).toContainEqual({
      source: filed.pagePath,
      target: hit.path,
      type: "link",
    });
    const refs = await resolveMemoryWikiPromotionReferences({
      config: personal,
      lookup: filed.pagePath,
      proposedText: `확인한 진단 [[${hit.path}]]`,
    });
    expect(refs!.references![0]).toMatchObject({ claimId: "concept.connection", kind: "personal" });
  });
  it("resolves only submitted links and preserves exact existing source and target revisions", async () => {
    const { config, rootDir } = await createVault({ initialize: true });
    const personal = {
      ...config,
      agentId: "main",
      vault: { ...config.vault, scope: "agent" as const },
    };
    await fs.writeFile(
      path.join(rootDir, "concepts/source.md"),
      "---\nid: source.stable\npageType: concept\n---\nSource [[elsewhere]]\n",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts/target.md"),
      "---\nid: target.stable\npageType: concept\nupdatedAt: 2026-09-13T00:00:00Z\n---\nTarget\n",
    );
    const text =
      "검증 [[concepts/target.md|비공개 별칭]] 누락 [[missing|비공개 이름]] [웹](https://example.com)";
    const resolved = await resolveMemoryWikiPromotionReferences({
      config: personal,
      lookup: "source.stable",
      proposedText: text,
    });
    const source = await getMemoryWikiPage({
      config: personal,
      lookup: "source.stable",
      fromLine: 1,
      lineCount: 10_000,
      searchCorpus: "wiki",
      searchBackend: "local",
    });
    const target = await getMemoryWikiPage({
      config: personal,
      lookup: "target.stable",
      fromLine: 1,
      lineCount: 10_000,
      searchCorpus: "wiki",
      searchBackend: "local",
    });
    expect(resolved).toMatchObject({
      claimId: "source.stable",
      revision: memoryWikiPromotionRevision({ claimId: "source.stable", ...source! }),
      referencesTextHash: memoryWikiReferenceTextHash(text),
    });
    expect(resolved!.references).toHaveLength(2);
    expect(resolved!.references![0]).toMatchObject({
      claimId: "target.stable",
      kind: "personal",
      revision: memoryWikiPromotionRevision({ claimId: "target.stable", ...target! }),
    });
    expect(resolved!.references![1]).toEqual({
      start: text.indexOf("[[missing"),
      end: text.indexOf(" [웹]"),
    });
    expect(JSON.stringify(resolved)).not.toMatch(/비공개|missing|elsewhere|concepts\//);
  });
});
