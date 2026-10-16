import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnterprisePrincipal } from "./contracts.js";
import type { SkillHubEditPlan } from "./skill-hub-state.js";
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

function principal(): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: "subject:admin.user",
    accountId: "admin.user",
    employeeId: "employee:admin.user",
    groups: [],
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Skill Hub governance queue fairness", () => {
  it.each(["cancel", "complete"] as const)(
    "selects healthy jobs behind reserved versions and releases them after edit %s",
    async (outcome) => {
      const directory = mkdtempSync(join(tmpdir(), "platformclaw-governance-queue-"));
      directories.push(directory);
      const databasePath = join(directory, "control.sqlite");
      let store = openStore(databasePath);
      const admin = (await store.upsertPrincipal(principal(), 1)).user;
      for (const namespace of ["source", "target", "healthy"]) {
        const binding = await store.setSkillHubNamespaceBinding({
          namespace,
          scopeKind: "global",
          accessState: "restricted",
          visibilityCeiling: "PUBLIC",
          expectedUpdatedAt: null,
          reason: "queue fixture",
          actorUserId: admin.id,
          changedAt: 3,
        });
        await store.setSkillHubNamespaceAccessState({
          namespace,
          accessState: "active",
          expectedUpdatedAt: binding.updatedAt,
          reason: "queue fixture activated",
          actorUserId: admin.id,
          changedAt: 4,
        });
      }
      for (const [namespace, slug] of [
        ["source", "demo"],
        ["source", "other-skill"],
        ["healthy", "demo"],
      ] as const) {
        await store.recordSkillHubPublication({
          namespace,
          slug,
          ownerUserId: admin.id,
          expectedOwnerUserId: null,
          expectedOwnerUpdatedAt: null,
          expectedBindingUpdatedAt: 4,
          visibility: "NAMESPACE_ONLY",
          version: "1.0.0",
          changedAt: 5,
        });
      }
      for (let index = 0; index < 11; index += 1) {
        const version = `1.0.${index}`;
        await store.enqueueSkillHubGovernanceJob({
          namespace: "source",
          slug: "demo",
          version,
          ownerUserId: admin.id,
          createdAt: 10 + index,
        });
        await store.updateSkillHubGovernanceJob({
          namespace: "source",
          slug: "demo",
          version,
          state: "pending",
          attempts: index + 1,
          nextAttemptAt: 10 + index,
          lastError: "scan-pending",
          updatedAt: 10 + index,
        });
      }
      for (const [namespace, slug] of [
        ["source", "other-skill"],
        ["healthy", "demo"],
      ] as const) {
        await store.enqueueSkillHubGovernanceJob({
          namespace,
          slug,
          version: "1.0.0",
          ownerUserId: admin.id,
          createdAt: 30,
        });
      }
      const plan: SkillHubEditPlan = {
        id: "reserved-edit",
        namespace: "source",
        slug: "demo",
        targetNamespace: outcome === "cancel" ? "source" : "target",
        skillId: 10,
        registryRevision: "original-revision",
        displayName: "Demo",
        summary: "Queue fairness fixture",
        visibility: "NAMESPACE_ONLY",
        actorUserId: admin.id,
        expectedOwnerUpdatedAt: 5,
        expectedSourceBindingUpdatedAt: 4,
        expectedTargetBindingUpdatedAt: 4,
        changedAt: 40,
      };
      await store.beginSkillHubEdit(plan);
      store.close();
      stores.splice(stores.indexOf(store), 1);
      store = openStore(databasePath);

      // A ten-job limit must not be consumed by the eleven older reserved jobs.
      const ready = await store.listDueSkillHubGovernanceJobs(100, 10);
      expect(ready.map((job) => `${job.namespace}/${job.slug}`).toSorted()).toEqual([
        "healthy/demo",
        "source/other-skill",
      ]);
      expect(ready.every((job) => job.attempts === 0)).toBe(true);
      await expect(
        store.getSkillHubPendingEdit(plan.targetNamespace, plan.slug),
      ).resolves.toMatchObject({ id: plan.id });

      if (outcome === "cancel") {
        await store.cancelSkillHubEdit({
          id: plan.id,
          actorUserId: admin.id,
          changedAt: 101,
          reason: "registry definitively rejected edit",
        });
      } else {
        await expect(
          store.completeSkillHubEdit({ id: plan.id, changedAt: 101 }),
        ).resolves.toMatchObject({ state: "completed", result: { reconciliationRequired: false } });
      }
      const released = await store.listDueSkillHubGovernanceJobs(102, 20);
      expect(released).toHaveLength(13);
      const previouslyReserved = released.filter(
        (job) => job.namespace === plan.targetNamespace && job.slug === plan.slug,
      );
      expect(previouslyReserved).toHaveLength(11);
      for (const job of previouslyReserved) {
        const index = Number(job.version.split(".")[2]);
        expect(job).toMatchObject({
          attempts: index + 1,
          nextAttemptAt: 10 + index,
          lastError: "scan-pending",
          state: "pending",
        });
      }
      await expect(
        store.getSkillHubPendingEdit(plan.targetNamespace, plan.slug),
      ).resolves.toBeNull();
    },
  );
});
