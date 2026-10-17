import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnterprisePrincipal } from "./contracts.js";
import type { SkillHubEditableMetadata } from "./skill-hub-governance-client.js";
import type { SkillHubEditPlan, SkillHubStateStore } from "./skill-hub-state.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const directories: string[] = [];
const stores: SqliteControlPlaneStore[] = [];

function openStore(databasePath: string) {
  const store = new SqliteControlPlaneStore({
    databasePath,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
  });
  stores.push(store);
  return store;
}

function principal(accountId: string): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: `subject:${accountId}`,
    accountId,
    employeeId: `employee:${accountId}`,
    groups: [],
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-skill-edit-"));
  directories.push(directory);
  const databasePath = join(directory, "control.sqlite");
  const store = openStore(databasePath);
  const admin = (await store.upsertPrincipal(principal("admin.user"), 1)).user;
  const recipient = (await store.upsertPrincipal(principal("recipient.user"), 2)).user;
  for (const namespace of ["source", "target"]) {
    const binding = await store.setSkillHubNamespaceBinding({
      namespace,
      scopeKind: "global",
      accessState: "restricted",
      visibilityCeiling: "PUBLIC",
      expectedUpdatedAt: null,
      reason: "edit fixture",
      actorUserId: admin.id,
      changedAt: 3,
    });
    await store.setSkillHubNamespaceAccessState({
      namespace,
      accessState: "active",
      expectedUpdatedAt: binding.updatedAt,
      reason: "edit fixture activated",
      actorUserId: admin.id,
      changedAt: 4,
    });
  }
  const ownership = await store.recordSkillHubPublication({
    namespace: "source",
    slug: "demo",
    ownerUserId: admin.id,
    expectedOwnerUserId: null,
    expectedOwnerUpdatedAt: null,
    expectedBindingUpdatedAt: 4,
    visibility: "NAMESPACE_ONLY",
    version: "1.0.0",
    changedAt: 5,
  });
  await store.setSkillHubAccess({
    namespace: "source",
    slug: "demo",
    userId: recipient.id,
    grantedByUserId: admin.id,
    expiresAt: 100,
    inheritVersions: false,
    grantedVersion: "1.0.0",
    changedAt: 6,
  });
  await store.enqueueSkillHubGovernanceJob({
    namespace: "source",
    slug: "demo",
    version: "1.0.0",
    ownerUserId: admin.id,
    createdAt: 6,
  });
  const plan: SkillHubEditPlan = {
    id: "edit-1",
    namespace: "source",
    slug: "demo",
    targetNamespace: "target",
    skillId: 10,
    registryRevision: "2026-10-16T00:00:00Z",
    displayName: "Edited demo",
    summary: "Edited summary",
    visibility: "NAMESPACE_ONLY",
    actorUserId: admin.id,
    expectedOwnerUpdatedAt: ownership.updatedAt,
    expectedSourceBindingUpdatedAt: 4,
    expectedTargetBindingUpdatedAt: 4,
    changedAt: 7,
  };
  return { store, databasePath, admin, recipient, plan };
}

function registryMetadata(plan: SkillHubEditPlan): SkillHubEditableMetadata {
  return {
    id: plan.skillId,
    namespace: plan.targetNamespace,
    slug: plan.slug,
    revision: "committed-edit",
    displayName: plan.displayName,
    summary: plan.summary,
    visibility: plan.visibility,
    effectiveVisibility: plan.visibility,
    reviewVersions: [],
  };
}

async function complete(
  store: SqliteControlPlaneStore,
  params: Parameters<SkillHubStateStore["completeSkillHubEdit"]>[0],
) {
  const completion = await store.completeSkillHubEdit(params);
  if (completion.state !== "completed") {
    throw new Error("Registry privacy must be confirmed first");
  }
  return completion.result;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("persistent Skill Hub edits", () => {
  it("recovers a reserved move after restart and atomically preserves ACLs and governance", async () => {
    const { store, databasePath, admin, recipient, plan } = await fixture();
    const intent = await store.beginSkillHubEdit(plan);
    expect(intent.originalOwnership).toMatchObject({
      ownerUserId: admin.id,
      currentVersion: "1.0.0",
    });
    await expect(store.getSkillHubPendingEdit("target", "demo")).resolves.toEqual(intent);
    await expect(
      store.beginSkillHubEdit({ ...plan, id: "overlapping", targetNamespace: "source" }),
    ).rejects.toThrow("edit is pending");
    await expect(
      store.removeSkillHubSkillState({
        namespace: "source",
        slug: "demo",
        actorUserId: admin.id,
        changedAt: 8,
      }),
    ).rejects.toThrow("edit is pending");
    await expect(
      store.setSkillHubAccess({
        namespace: "source",
        slug: "demo",
        userId: recipient.id,
        grantedByUserId: admin.id,
        inheritVersions: true,
        changedAt: 8,
      }),
    ).rejects.toThrow("edit is pending");
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const recovered = openStore(databasePath);
    await expect(recovered.listPendingSkillHubEdits()).resolves.toEqual([intent]);
    const result = await complete(recovered, { id: plan.id, changedAt: 8 });
    expect(result).toMatchObject({
      reconciliationRequired: false,
      ownership: {
        namespace: "target",
        ownerUserId: admin.id,
        currentVersion: "1.0.0",
        updatedAt: 8,
      },
    });
    await expect(complete(recovered, { id: plan.id, changedAt: 50 })).resolves.toEqual(result);
    await expect(recovered.getSkillHubOwnership("source", "demo")).resolves.toBeNull();
    await expect(recovered.listSkillHubAccess("source", "demo", 8)).resolves.toEqual([]);
    await expect(recovered.listSkillHubAccess("target", "demo", 8)).resolves.toEqual([
      expect.objectContaining({
        userId: recipient.id,
        expiresAt: 100,
        inheritVersions: false,
        grantedVersion: "1.0.0",
        createdAt: 6,
      }),
    ]);
    await expect(recovered.listDueSkillHubGovernanceJobs(8, 10)).resolves.toEqual([
      expect.objectContaining({
        namespace: "target",
        slug: "demo",
        ownerUserId: admin.id,
        version: "1.0.0",
        state: "pending",
      }),
    ]);
    await expect(recovered.getSkillHubPendingEdit("target", "demo")).resolves.toBeNull();
    await expect(recovered.getSkillHubEdit(plan.id)).resolves.toMatchObject({
      state: "completed",
      result,
    });
  });

  it("persists privacy recovery across restart and restored policy before moving local state", async () => {
    const { store, databasePath, admin, plan } = await fixture();
    await store.beginSkillHubEdit(plan);
    await store.setSkillHubNamespaceAccessState({
      namespace: "target",
      accessState: "restricted",
      expectedUpdatedAt: 4,
      reason: "policy changed during registry edit",
      actorUserId: admin.id,
      changedAt: 8,
    });
    const metadata = registryMetadata(plan);
    const pending = await store.completeSkillHubEdit({
      id: plan.id,
      changedAt: 9,
      registryMetadata: metadata,
    });
    expect(pending.state).toBe("privacy-required");
    if (pending.state !== "privacy-required") {
      throw new Error("Missing privacy phase");
    }
    const request = pending.intent.privacy!;
    expect(request).toMatchObject({
      namespace: "target",
      targetNamespace: "target",
      visibility: "PRIVATE",
      expectedRevision: metadata.revision,
    });
    expect(request.operationId).not.toBe(plan.id);
    await expect(store.getSkillHubOwnership("target", "demo")).resolves.toBeNull();
    await expect(store.getSkillHubPendingEdit("source", "demo")).resolves.toMatchObject({
      privacy: request,
    });
    await expect(
      store.cancelSkillHubEdit({
        id: plan.id,
        actorUserId: admin.id,
        changedAt: 9,
        reason: "cannot abandon committed shared mutation",
      }),
    ).rejects.toThrow("privacy recovery must finish");
    await expect(
      store.completeSkillHubEdit({
        id: plan.id,
        changedAt: 9,
        registryMetadata: { ...metadata, visibility: "PRIVATE" },
        privacyConfirmedOperationId: request.operationId,
      }),
    ).rejects.toThrow("not been confirmed");
    await store.setSkillHubNamespaceAccessState({
      namespace: "target",
      accessState: "active",
      expectedUpdatedAt: 8,
      reason: "policy restored while privacy recovery remained pending",
      actorUserId: admin.id,
      changedAt: 10,
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const recovered = openStore(databasePath);
    await expect(recovered.listPendingSkillHubEdits()).resolves.toEqual([pending.intent]);
    const final = await complete(recovered, {
      id: plan.id,
      changedAt: 11,
      registryMetadata: { ...metadata, visibility: "PRIVATE", effectiveVisibility: "PRIVATE" },
      privacyConfirmedOperationId: request.operationId,
    });
    expect(final).toMatchObject({
      reconciliationRequired: true,
      ownership: {
        namespace: "target",
        ownerUserId: null,
        previousOwnerUserId: admin.id,
        visibility: "PRIVATE",
      },
    });
    await expect(recovered.getSkillHubPendingEdit("source", "demo")).resolves.toBeNull();
    await expect(recovered.listDueSkillHubGovernanceJobs(12, 10)).resolves.toEqual([]);
    await expect(recovered.listSkillHubNotifications(admin.id, 10)).resolves.toContainEqual(
      expect.objectContaining({ kind: "owner-unassigned", namespace: "target", slug: "demo" }),
    );
  });

  it("persists a new privacy request only after a definite CAS rejection and exact identity check", async () => {
    const { store, admin, plan } = await fixture();
    await store.beginSkillHubEdit(plan);
    await store.setSkillHubNamespaceAccessState({
      namespace: "target",
      accessState: "restricted",
      expectedUpdatedAt: 4,
      reason: "policy drift",
      actorUserId: admin.id,
      changedAt: 8,
    });
    const metadata = registryMetadata(plan);
    const pending = await store.completeSkillHubEdit({
      id: plan.id,
      changedAt: 9,
      registryMetadata: metadata,
    });
    if (pending.state !== "privacy-required") {
      throw new Error("Missing privacy phase");
    }
    const prior = pending.intent.privacy!;
    await expect(
      store.rebaseSkillHubEditPrivacy({
        id: plan.id,
        expectedOperationId: prior.operationId,
        metadata: { ...metadata, id: 999 },
        changedAt: 10,
      }),
    ).rejects.toThrow("identity does not match");
    const updated = await store.rebaseSkillHubEditPrivacy({
      id: plan.id,
      expectedOperationId: prior.operationId,
      metadata: { ...metadata, revision: "after-native-approval", displayName: "Current title" },
      changedAt: 10,
    });
    expect(updated.privacy).toMatchObject({
      expectedRevision: "after-native-approval",
      displayName: "Current title",
      visibility: "PRIVATE",
    });
    expect(updated.privacy!.operationId).not.toBe(prior.operationId);
    await expect(
      store.rebaseSkillHubEditPrivacy({
        id: plan.id,
        expectedOperationId: prior.operationId,
        metadata,
        changedAt: 11,
      }),
    ).rejects.toThrow("attempt changed");
    const notConfirmed = await store.completeSkillHubEdit({
      id: plan.id,
      changedAt: 11,
      registryMetadata: { ...metadata, visibility: "PRIVATE", effectiveVisibility: "PRIVATE" },
      privacyConfirmedOperationId: prior.operationId,
    });
    expect(notConfirmed).toMatchObject({
      state: "privacy-required",
      intent: { privacy: updated.privacy },
    });
  });

  it("pauses approval for Private edits and resumes only visibility-paused jobs", async () => {
    const { store, plan } = await fixture();
    await store.enqueueSkillHubGovernanceJob({
      namespace: "source",
      slug: "demo",
      version: "0.9.0",
      ownerUserId: plan.actorUserId,
      createdAt: 6,
    });
    await store.updateSkillHubGovernanceJob({
      namespace: "source",
      slug: "demo",
      version: "0.9.0",
      state: "blocked",
      attempts: 1,
      nextAttemptAt: 6,
      lastError: "scan-unsafe",
      updatedAt: 6,
    });
    await store.beginSkillHubEdit({ ...plan, targetNamespace: "source", visibility: "PRIVATE" });
    const privateResult = await complete(store, { id: plan.id, changedAt: 5 });
    expect(privateResult.ownership.updatedAt).toBe(6);
    await expect(store.listDueSkillHubGovernanceJobs(10, 10)).resolves.toEqual([]);
    await store.beginSkillHubEdit({
      ...plan,
      id: "relax-private",
      targetNamespace: "source",
      expectedOwnerUpdatedAt: privateResult.ownership.updatedAt,
      changedAt: 10,
    });
    await complete(store, { id: "relax-private", changedAt: 11 });
    await expect(store.listDueSkillHubGovernanceJobs(11, 10)).resolves.toEqual([
      expect.objectContaining({ state: "pending", namespace: "source", nextAttemptAt: 11 }),
    ]);
  });

  it("creates missing scan governance when an originally Private version becomes shared", async () => {
    const { store, admin, plan } = await fixture();
    const ownership = await store.recordSkillHubPublication({
      namespace: "source",
      slug: "private-demo",
      ownerUserId: admin.id,
      expectedOwnerUserId: null,
      expectedOwnerUpdatedAt: null,
      expectedBindingUpdatedAt: 4,
      visibility: "PRIVATE",
      version: "2.0.0",
      changedAt: 7,
    });
    await store.beginSkillHubEdit({
      ...plan,
      slug: "private-demo",
      targetNamespace: "source",
      expectedOwnerUpdatedAt: ownership.updatedAt,
    });
    await complete(store, {
      id: plan.id,
      changedAt: 8,
      reviewVersions: ["1.0.0", "2.0.0", "1.0.0"],
    });
    const due = await store.listDueSkillHubGovernanceJobs(8, 10);
    const prepared = due.filter((job) => job.slug === "private-demo");
    expect(prepared).toHaveLength(2);
    expect(prepared).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "source",
          slug: "private-demo",
          version: "2.0.0",
          ownerUserId: admin.id,
          state: "pending",
        }),
        expect.objectContaining({
          namespace: "source",
          slug: "private-demo",
          version: "1.0.0",
          ownerUserId: admin.id,
          state: "pending",
        }),
      ]),
    );
  });

  it.each([true, false])(
    "reopens every previous decision only with an explicit registry review list (%s)",
    async (reviewRequired) => {
      const { store, admin, plan } = await fixture();
      for (const [version, state] of [
        ["1.0.0", "approved"],
        ["0.9.0", "blocked"],
        ["0.8.0", "failed"],
        ["0.7.0", "approved"],
        ["0.6.0", "pending"],
      ] as const) {
        await store.enqueueSkillHubGovernanceJob({
          namespace: "source",
          slug: "demo",
          version,
          ownerUserId: admin.id,
          createdAt: 6,
        });
        await store.updateSkillHubGovernanceJob({
          namespace: "source",
          slug: "demo",
          version,
          state,
          attempts: 3,
          nextAttemptAt: 6,
          lastError: state === "blocked" ? "scan-unsafe" : "previous-decision",
          updatedAt: 6,
        });
      }
      await store.beginSkillHubEdit({ ...plan, visibility: "PUBLIC" });
      const result = await complete(store, {
        id: plan.id,
        changedAt: 8,
        ...(reviewRequired
          ? { reviewVersions: ["1.0.0", "0.9.0", "0.8.0", "0.6.0"], publicationPending: true }
          : {}),
      });
      const due = await store.listDueSkillHubGovernanceJobs(8, 10);
      expect(due.map((job) => job.version).toSorted()).toEqual(
        reviewRequired ? ["0.6.0", "0.8.0", "0.9.0", "1.0.0"] : ["0.6.0"],
      );
      for (const job of due) {
        expect(job).toMatchObject({
          namespace: "target",
          state: "pending",
          attempts: reviewRequired ? 0 : 3,
          nextAttemptAt: reviewRequired ? 8 : 6,
          ownerUserId: admin.id,
        });
        if (reviewRequired) {
          expect(job.lastError).toBeUndefined();
        }
      }
      expect(result.publicationPending).toBe(reviewRequired ? true : undefined);
      await expect(complete(store, { id: plan.id, changedAt: 9 })).resolves.toEqual(result);
    },
  );

  it("rejects an unbound destination as a controlled conflict before reserving or mutating state", async () => {
    const { store, admin, plan } = await fixture();
    await store.removeSkillHubNamespaceBinding({
      namespace: "target",
      expectedUpdatedAt: 4,
      reason: "destination unbound before edit",
      actorUserId: admin.id,
      changedAt: 8,
    });
    await expect(store.beginSkillHubEdit(plan)).rejects.toMatchObject({
      code: "skill_hub_owner_changed",
      message: "Skill Hub skill or namespace changed; reload and retry",
    });
    await expect(store.getSkillHubEdit(plan.id)).resolves.toBeNull();
    await expect(store.getSkillHubOwnership("source", "demo")).resolves.toMatchObject({
      ownerUserId: admin.id,
    });
  });

  it("rejects stale plans and releases reservations after definitive cancellation", async () => {
    const { store, admin, plan } = await fixture();
    await expect(store.beginSkillHubEdit({ ...plan, expectedOwnerUpdatedAt: 1 })).rejects.toThrow(
      "reload and retry",
    );
    await store.beginSkillHubEdit(plan);
    await store.cancelSkillHubEdit({
      id: plan.id,
      actorUserId: admin.id,
      changedAt: 8,
      reason: "registry rejected stale revision without a mutation",
    });
    await expect(store.getSkillHubPendingEdit("source", "demo")).resolves.toBeNull();
    await expect(store.getSkillHubEdit(plan.id)).resolves.toMatchObject({ state: "cancelled" });
    await expect(complete(store, { id: plan.id, changedAt: 9 })).rejects.toThrow(
      "no longer pending",
    );
    await expect(store.beginSkillHubEdit({ ...plan, id: "retry-edit" })).resolves.toMatchObject({
      state: "pending",
    });
  });
});
