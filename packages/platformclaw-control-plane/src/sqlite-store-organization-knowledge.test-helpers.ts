import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import type { PersonalOrganizationMemorySourceResolver } from "./contracts.js";
import { ORGANIZATION_KNOWLEDGE_POLICY_VERSION } from "./organization-knowledge-analysis.js";
import type {
  OrganizationKnowledgeAnalysis,
  OrganizationKnowledgeAnalysisInput,
} from "./organization-memory-knowledge-contracts.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

export const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) {
    close();
  }
});

export async function fixture(resolvePersonalSource?: PersonalOrganizationMemorySourceResolver) {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-knowledge-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const options = {
    databasePath: join(directory, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }: { agentId: string }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["test-admin"],
    resolvePersonalOrganizationMemorySource:
      resolvePersonalSource ??
      (async ({ lookup }: { lookup: string }) => ({
        claimId: lookup,
        revision: 1,
      })),
  };
  const store = new SqliteControlPlaneStore(options);
  cleanup.push(() => store.close());
  async function actor(accountId: string) {
    const { user } = await store.upsertPrincipal(
      { provider: "ldap", subject: accountId, accountId, employeeId: accountId },
      1,
    );
    const reservation = await store.reservePersonalAgent(user.id, 2);
    const binding = await store.transitionAgent({
      bindingId: reservation.binding.id,
      state: "active",
      changedAt: 3,
    });
    return { userId: user.id, agentId: binding.agentId };
  }
  const admin = await actor("test-admin");
  const leader = await actor("test-leader");
  const secondLeader = await actor("test-second-leader");
  const ancestor = await actor("test-ancestor-leader");
  const team = await store.createManagedScope({
    actorUserId: admin.userId,
    kind: "team",
    name: "Synthetic Team",
    createdAt: 4,
  });
  const group = await store.createManagedScope({
    actorUserId: admin.userId,
    kind: "group",
    name: "Synthetic Group",
    parentScopeId: team.id,
    createdAt: 5,
  });
  const part = await store.createManagedScope({
    actorUserId: admin.userId,
    kind: "part",
    name: "Synthetic Part",
    parentScopeId: group.id,
    createdAt: 6,
  });
  async function membership(userId: string, role: "member" | "leader", scopeId = part.id) {
    await store.setManagedScopeMembership({
      actorUserId: admin.userId,
      scopeId,
      userId,
      role,
      reason: "Synthetic test assignment",
      changedAt: 7,
    });
  }
  await membership(leader.userId, "leader");
  await membership(secondLeader.userId, "leader");
  await membership(ancestor.userId, "leader", group.id);
  const claims = [];
  for (const text of [
    "Test condition alpha: perform a dry run.",
    "Test condition beta: perform a dry run.",
  ]) {
    const request = await store.publishOrganizationMemoryDirect({
      agentId: admin.agentId,
      sourceKind: "personal",
      sourceClaimId: `wiki/${claims.length}.md`,
      targetKind: "part",
      targetScopeId: part.id,
      proposedText: text,
      evidence: ["Synthetic approved example"],
      reason: "Synthetic approved test data",
      publishedAt: 8,
    });
    claims.push(request.targetClaimId!);
  }
  return {
    store,
    options,
    admin,
    leader,
    secondLeader,
    ancestor,
    part,
    group,
    team,
    claims,
    membership,
    actor,
  };
}

export function analysis(input: OrganizationKnowledgeAnalysisInput): OrganizationKnowledgeAnalysis {
  return {
    summary: "Synthetic comparison",
    coverage: {
      strategy: "candidate-pairs",
      policyVersion: ORGANIZATION_KNOWLEDGE_POLICY_VERSION,
      candidatePairs: 1,
      comparedPairs: 1,
      hasUncomparedPairs: false,
    },
    comparisons: [
      {
        kind: "condition-difference",
        claimIds: input.claims.map((claim) => claim.id),
        claimRevisions: input.claims.map(({ id, revision }) => ({ id, revision })),
        summary: "Alpha and beta describe different conditions.",
        proposedText: "Perform a dry run under alpha or beta conditions.",
      },
    ],
  };
}

export async function generateSuccess(f: Awaited<ReturnType<typeof fixture>>, requestId = "first") {
  const snapshot = await f.store.enqueueOrganizationKnowledge({
    agentId: f.leader.agentId,
    scopeId: f.part.id,
    requestId,
    now: 100,
  });
  const job = await f.store.claimOrganizationKnowledgeJob({ owner: "test-worker", now: 101 });
  expect(job?.input).not.toBeNull();
  await f.store.finishOrganizationKnowledgeJob({
    jobId: job!.jobId,
    owner: "test-worker",
    now: 102,
    analysis: analysis(job!.input!),
  });
  return snapshot.currentJob!.id;
}
