import {
  memoryWikiReferenceTextHash,
  parseMemoryWikiReferenceSpans,
} from "@openclaw/memory-wiki/reference-api";
import { describe, expect, it } from "vitest";
import { runImmediateTransaction } from "./kysely-sync.js";
import { ORGANIZATION_KNOWLEDGE_POLICY_VERSION } from "./organization-knowledge-analysis.js";
import { cleanup, fixture } from "./sqlite-store-organization-knowledge.test-helpers.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

class CompilerFixtureStore extends SqliteControlPlaneStore {
  recompile(claimId: string) {
    runImmediateTransaction(this.db, () => this.compileClaimPage(claimId));
  }
}

async function setup() {
  return fixture(async ({ lookup, proposedText }) => ({
    claimId: lookup,
    revision: 1,
    ...(proposedText === undefined
      ? {}
      : {
          referencesTextHash: memoryWikiReferenceTextHash(proposedText),
          references: parseMemoryWikiReferenceSpans(proposedText).map(({ start, end, target }) => ({
            start,
            end,
            claimId: target === "linked" ? "wiki/target.md" : undefined,
            revision: target === "linked" ? 1 : undefined,
            kind: target === "linked" ? ("personal" as const) : undefined,
          })),
        }),
  }));
}
async function ownTarget(f: Awaited<ReturnType<typeof setup>>, sourceId = "wiki/target.md") {
  const request = await f.store.submitOrganizationMemoryPromotion({
    agentId: f.leader.agentId,
    sourceKind: "personal",
    sourceClaimId: sourceId,
    targetKind: "part",
    targetScopeId: f.part.id,
    proposedText: "Approved destination related document",
    evidence: [],
    reason: "Synthetic target",
    submittedAt: 10,
  });
  const approved = await f.store.decideOrganizationMemoryPromotion({
    agentId: f.secondLeader.agentId,
    requestId: request.id,
    decision: "approve",
    reason: "Synthetic approval",
    decidedAt: 11,
  });
  return approved.targetClaimId!;
}
function input(
  f: Awaited<ReturnType<typeof setup>>,
  proposedText = "Public statement [[linked|PRIVATE ALIAS]]",
) {
  return {
    agentId: f.leader.agentId,
    sourceKind: "personal" as const,
    sourceClaimId: "wiki/source.md",
    targetKind: "part" as const,
    targetScopeId: f.part.id,
    proposedText,
  };
}
describe("promotion reference owner", () => {
  it("same-scope apply preserves survivor refs and requires promotion preview for new links", async () => {
    const f = await setup();
    const target = await ownTarget(f);
    const params = input(f);
    const preview = await f.store.previewOrganizationMemoryPromotionReferences(params);
    const request = await f.store.submitOrganizationMemoryPromotion({
      ...params,
      expectedReferencesFingerprint: preview.references!.fingerprint,
      evidence: [],
      reason: "Synthetic",
      submittedAt: 12,
    });
    const source = (
      await f.store.decideOrganizationMemoryPromotion({
        agentId: f.secondLeader.agentId,
        requestId: request.id,
        decision: "approve",
        expectedReferencesFingerprint: request.references!.fingerprint,
        reason: "Synthetic",
        decidedAt: 13,
      })
    ).targetClaimId!;
    await f.store.enqueueOrganizationKnowledge({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      requestId: "reference-revision",
      now: 100,
    });
    const job = (await f.store.claimOrganizationKnowledgeJob({
      owner: "reference-test",
      now: 101,
    }))!;
    const ids = [source, f.claims[0]!];
    await f.store.finishOrganizationKnowledgeJob({
      jobId: job.jobId,
      owner: "reference-test",
      now: 102,
      analysis: {
        summary: "Synthetic enrichment",
        coverage: {
          strategy: "candidate-pairs",
          policyVersion: ORGANIZATION_KNOWLEDGE_POLICY_VERSION,
          candidatePairs: 1,
          comparedPairs: 1,
          hasUncomparedPairs: true,
        },
        comparisons: [
          {
            kind: "enrichment",
            claimIds: ids,
            claimRevisions: ids.map((id) => ({
              id,
              revision: job.input!.claims.find((claim) => claim.id === id)!.revision,
            })),
            summary: "Synthetic review",
            proposedText: "Public merged statement",
          },
        ],
      },
    });
    const proposal = (
      await f.store.getOrganizationKnowledgeSnapshot({
        agentId: f.leader.agentId,
        scopeId: f.part.id,
      })
    ).selected!.proposals[0]!;
    await f.store.decideOrganizationKnowledgeProposal({
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      proposalId: proposal.id,
      expectedRevision: 0,
      decision: "approve",
      reason: "Synthetic",
      now: 103,
    });
    const apply = {
      agentId: f.leader.agentId,
      scopeId: f.part.id,
      proposalId: proposal.id,
      expectedRevision: 1,
      survivorClaimId: source,
      reason: "Synthetic",
      now: 104,
    };
    await expect(
      f.store.applyOrganizationKnowledgeProposal({
        ...apply,
        proposedText: "New [[PRIVATE PATH|PRIVATE TITLE]]",
      }),
    ).rejects.toThrow("promotion reference preview");
    await f.store.applyOrganizationKnowledgeProposal({
      ...apply,
      proposedText: "Public merged statement",
    });
    const graph = await f.store.getOrganizationMemoryGraph({
      agentId: f.leader.agentId,
      kind: "part",
    });
    expect(graph.edges).toContainEqual({
      source: `organization:part:${source}`,
      target: `organization:part:${target}`,
      type: "reference",
      sourceRevision: 2,
      targetRevision: 1,
      inputStatus: "current",
    });
  });
  it("keeps same private path pending requests independent across requester namespaces", async () => {
    const f = await setup();
    const params = {
      ...input(f, "No references"),
      evidence: [],
      reason: "Synthetic",
      submittedAt: 12,
    };
    const first = await f.store.submitOrganizationMemoryPromotion(params);
    const second = await f.store.submitOrganizationMemoryPromotion({
      ...params,
      agentId: f.secondLeader.agentId,
    });
    expect(first.id).not.toBe(second.id);
  });
  it("does not let Group oversight disclose a Part document to the Group audience", async () => {
    const f = await setup();
    const target = await ownTarget(f);
    expect(
      await f.store.getOrganizationMemory({
        agentId: f.ancestor.agentId,
        path: `organization/part/${target}`,
      }),
    ).not.toBeNull();
    const preview = await f.store.previewOrganizationMemoryPromotionReferences({
      ...input(f, `Public [[organization/part/${target}|PRIVATE PART TITLE]]`),
      agentId: f.ancestor.agentId,
      targetKind: "group",
      targetScopeId: f.group.id,
    });
    expect(preview.references).toMatchObject({ resolved: [], unresolvedCount: 1 });
    expect(JSON.stringify(preview)).not.toContain("PRIVATE PART TITLE");
  });
  it("hidden copies cannot affect lookup limits or the public fingerprint", async () => {
    const f = await setup();
    await ownTarget(f);
    const before = await f.store.previewOrganizationMemoryPromotionReferences(input(f));
    const group = await f.store.createManagedScope({
      actorUserId: f.admin.userId,
      kind: "group",
      name: "Hidden synthetic group",
      parentScopeId: f.team.id,
      createdAt: 20,
    });
    const part = await f.store.createManagedScope({
      actorUserId: f.admin.userId,
      kind: "part",
      name: "Hidden synthetic part",
      parentScopeId: group.id,
      createdAt: 21,
    });
    await f.membership(f.leader.userId, "member", part.id);
    for (let index = 0; index < 65; index++) {
      const request = await f.store.submitOrganizationMemoryPromotion({
        ...input(f, `Hidden synthetic copy ${index}`),
        sourceClaimId: "wiki/target.md",
        targetScopeId: part.id,
        evidence: [],
        reason: "Synthetic",
        submittedAt: 22,
      });
      await f.store.decideOrganizationMemoryPromotion({
        agentId: f.admin.agentId,
        requestId: request.id,
        decision: "approve",
        reason: "Synthetic",
        decidedAt: 23,
      });
    }
    await f.store.removeManagedScopeMembership({
      actorUserId: f.admin.userId,
      userId: f.leader.userId,
      scopeId: part.id,
      reason: "Synthetic revoke",
      changedAt: 24,
    });
    expect(await f.store.previewOrganizationMemoryPromotionReferences(input(f))).toEqual(before);
  });
  it("direct publication requires reference review and compiler output is idempotent", async () => {
    const f = await setup();
    const params = {
      ...input(f, `Public [[organization/part/${f.claims[0]}|PRIVATE]]`),
      agentId: f.admin.agentId,
    };
    await expect(
      f.store.publishOrganizationMemoryDirect({
        ...params,
        evidence: [],
        reason: "Synthetic",
        publishedAt: 12,
      }),
    ).rejects.toThrow("reference preview changed");
    const preview = await f.store.previewOrganizationMemoryPromotionReferences(params);
    expect(preview.references?.resolved).toHaveLength(1);
    const approved = await f.store.publishOrganizationMemoryDirect({
      ...params,
      expectedReferencesFingerprint: preview.references!.fingerprint,
      evidence: [],
      reason: "Synthetic",
      publishedAt: 12,
    });
    const page = () =>
      f.store.getOrganizationMemory({
        agentId: f.leader.agentId,
        path: `organization/part/${approved.targetClaimId}`,
      });
    const before = await page();
    const compiler = new CompilerFixtureStore(f.options);
    cleanup.push(() => compiler.close());
    compiler.recompile(approved.targetClaimId!);
    compiler.recompile(approved.targetClaimId!);
    expect(await page()).toEqual(before);
    expect(JSON.stringify(await page())).toContain(`organization/part/${f.claims[0]}`);
  });
  it("new ambiguity after submission requires an explicit refreshed approval preview", async () => {
    const f = await setup();
    await ownTarget(f);
    const params = input(f);
    const preview = await f.store.previewOrganizationMemoryPromotionReferences(params);
    const request = await f.store.submitOrganizationMemoryPromotion({
      ...params,
      expectedReferencesFingerprint: preview.references!.fingerprint,
      evidence: [],
      reason: "Synthetic",
      submittedAt: 12,
    });
    await ownTarget(f);
    await expect(
      f.store.decideOrganizationMemoryPromotion({
        agentId: f.secondLeader.agentId,
        requestId: request.id,
        decision: "approve",
        expectedReferencesFingerprint: request.references!.fingerprint,
        reason: "Synthetic",
        decidedAt: 14,
      }),
    ).rejects.toThrow("reference preview changed");
    const refreshed = (
      await f.store.getOrganizationMemoryLifecycle(f.secondLeader.agentId)
    ).reviewable.find((value) => value.id === request.id)!;
    expect(refreshed.references).toMatchObject({ resolved: [], ambiguousCount: 1 });
    expect(refreshed.references!.fingerprint).not.toBe(request.references!.fingerprint);
  });
  it("previews safe destination mappings, approves frozen identities, compiles and graphs pinned refs", async () => {
    const f = await setup();
    const target = await ownTarget(f);
    const params = input(f);
    const preview = await f.store.previewOrganizationMemoryPromotionReferences(params);
    expect(preview.proposedText).toBe("Public statement (관련 문서 참조)");
    expect(preview.references?.resolved.map((value) => value.id)).toEqual([target]);
    expect(JSON.stringify(preview)).not.toContain("PRIVATE ALIAS");
    const request = await f.store.submitOrganizationMemoryPromotion({
      ...params,
      expectedReferencesFingerprint: preview.references!.fingerprint,
      evidence: [],
      reason: "Synthetic links",
      submittedAt: 12,
    });
    expect(request.proposedText).toBe(preview.proposedText);
    const approved = await f.store.decideOrganizationMemoryPromotion({
      agentId: f.secondLeader.agentId,
      requestId: request.id,
      decision: "approve",
      expectedReferencesFingerprint: request.references!.fingerprint,
      reason: "Synthetic review",
      decidedAt: 13,
    });
    const graph = await f.store.getOrganizationMemoryGraph({
      agentId: f.leader.agentId,
      kind: "part",
    });
    expect(graph.edges).toContainEqual({
      source: `organization:part:${approved.targetClaimId}`,
      target: `organization:part:${target}`,
      type: "reference",
      sourceRevision: 1,
      targetRevision: 1,
      inputStatus: "current",
    });
    const page = await f.store.getOrganizationMemory({
      agentId: f.leader.agentId,
      path: `organization/part/${approved.targetClaimId}`,
    });
    expect(JSON.stringify(page)).toContain(`organization/part/${target}`);
    expect(JSON.stringify(page)).not.toContain("PRIVATE ALIAS");
  });
  it("requires exact reviewed body fingerprint and retains no half-written request", async () => {
    const f = await setup();
    await ownTarget(f);
    const params = input(f);
    const preview = await f.store.previewOrganizationMemoryPromotionReferences(params);
    await expect(
      f.store.submitOrganizationMemoryPromotion({
        ...params,
        proposedText: params.proposedText + " changed",
        expectedReferencesFingerprint: preview.references!.fingerprint,
        evidence: [],
        reason: "Synthetic",
        submittedAt: 12,
      }),
    ).rejects.toThrow("reference preview changed");
    const lifecycle = await f.store.getOrganizationMemoryLifecycle(f.leader.agentId);
    expect(lifecycle.submitted.some((request) => request.sourceClaimId === "wiki/source.md")).toBe(
      false,
    );
  });
  it("fails closed on missing or same-origin ambiguous copies and requires review even when none resolve", async () => {
    const f = await setup();
    const missing = await f.store.previewOrganizationMemoryPromotionReferences(input(f));
    expect(missing.references).toMatchObject({ resolved: [], unresolvedCount: 1 });
    await ownTarget(f);
    await ownTarget(f);
    const ambiguous = await f.store.previewOrganizationMemoryPromotionReferences(input(f));
    expect(ambiguous.references).toMatchObject({ resolved: [], ambiguousCount: 1 });
    await expect(
      f.store.submitOrganizationMemoryPromotion({
        ...input(f),
        evidence: [],
        reason: "Synthetic",
        submittedAt: 15,
      }),
    ).rejects.toThrow("reference preview changed");
  });
  it("does not match another requester's identical private identity", async () => {
    const f = await setup();
    await f.store.publishOrganizationMemoryDirect({
      agentId: f.admin.agentId,
      sourceKind: "personal",
      sourceClaimId: "wiki/target.md",
      targetKind: "part",
      targetScopeId: f.part.id,
      proposedText: "Other namespace",
      evidence: [],
      reason: "Synthetic",
      publishedAt: 10,
    });
    const preview = await f.store.previewOrganizationMemoryPromotionReferences(input(f));
    expect(preview.references).toMatchObject({ resolved: [], unresolvedCount: 1 });
  });
  it("target retirement invalidates pending fingerprints and removes current inbound edges", async () => {
    const f = await setup();
    const target = await ownTarget(f);
    const params = input(f);
    const preview = await f.store.previewOrganizationMemoryPromotionReferences(params);
    const request = await f.store.submitOrganizationMemoryPromotion({
      ...params,
      expectedReferencesFingerprint: preview.references!.fingerprint,
      evidence: [],
      reason: "Synthetic",
      submittedAt: 12,
    });
    const approved = await f.store.decideOrganizationMemoryPromotion({
      agentId: f.secondLeader.agentId,
      requestId: request.id,
      decision: "approve",
      expectedReferencesFingerprint: request.references!.fingerprint,
      reason: "Synthetic",
      decidedAt: 12,
    });
    const pending = await f.store.submitOrganizationMemoryPromotion({
      ...params,
      sourceClaimId: "wiki/second-source.md",
      expectedReferencesFingerprint: (
        await f.store.previewOrganizationMemoryPromotionReferences({
          ...params,
          sourceClaimId: "wiki/second-source.md",
        })
      ).references!.fingerprint,
      evidence: [],
      reason: "Synthetic",
      submittedAt: 12,
    });
    await f.store.retireOrganizationMemoryClaim({
      agentId: f.secondLeader.agentId,
      claimId: target,
      reason: "Synthetic retirement",
      retiredAt: 13,
    });
    await expect(
      f.store.decideOrganizationMemoryPromotion({
        agentId: f.secondLeader.agentId,
        requestId: pending.id,
        decision: "approve",
        expectedReferencesFingerprint: pending.references!.fingerprint,
        reason: "Synthetic",
        decidedAt: 14,
      }),
    ).rejects.toThrow("reference preview changed");
    const graph = await f.store.getOrganizationMemoryGraph({
      agentId: f.leader.agentId,
      kind: "part",
    });
    expect(
      graph.edges.some(
        (edge) => edge.type === "reference" && edge.target === `organization:part:${target}`,
      ),
    ).toBe(false);
    const page = await f.store.getOrganizationMemory({
      agentId: f.leader.agentId,
      path: `organization/part/${approved.targetClaimId}`,
    });
    expect(JSON.stringify(page)).not.toContain(`organization/part/${target}`);
  });
  it("preserves external URLs and neutralizes definition, image and managed-section private aliases", async () => {
    const f = await setup();
    const text =
      'Public [web](https://example.com/x) ![PRIVATE IMAGE](private.png)\n\n[PRIVATE LABEL][secret]\n\n[secret]: private.md "PRIVATE TITLE"\n\n## Related\n<!-- openclaw:wiki:related:start -->\n[[private.md|PRIVATE RELATED]]\n<!-- openclaw:wiki:related:end -->';
    const preview = await f.store.previewOrganizationMemoryPromotionReferences(input(f, text));
    expect(preview.proposedText).toContain("[web](https://example.com/x)");
    expect(preview.proposedText).not.toMatch(/PRIVATE|private\.md|private\.png/);
    expect(preview.references?.unresolvedCount).toBe(4);
  });
});
