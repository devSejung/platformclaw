import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnterprisePrincipal } from "./contracts.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const stores: SqliteControlPlaneStore[] = [];
const directories: string[] = [];
function open(databasePath: string) {
  const db = new SqliteControlPlaneStore({
    databasePath,
    initialAdminAccountIds: ["admin.user"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  stores.push(db);
  return db;
}
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "platformclaw-namespace-create-"));
  directories.push(directory);
  const databasePath = path.join(directory, "control.sqlite");
  return { db: open(databasePath), databasePath };
}
function principal(accountId: string): EnterprisePrincipal {
  return { provider: "ldap", subject: accountId, accountId, employeeId: accountId, groups: [] };
}
afterEach(() => {
  for (const db of stores.splice(0)) {
    db.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable Skill Hub namespace creation", () => {
  it("preserves default Global restrictions across restart and allows custom Global removal", async () => {
    const { db, databasePath } = fixture();
    const member = (await db.upsertPrincipal(principal("member.user"), 1)).user;
    await db.ensureDefaultSkillHubNamespace({ actorUserId: member.id, changedAt: 2 });
    const admin = (await db.upsertPrincipal(principal("admin.user"), 3)).user;
    await expect(
      db.removeSkillHubNamespaceBinding({
        namespace: "global",
        expectedUpdatedAt: 2,
        reason: "disable default",
        actorUserId: admin.id,
        changedAt: 4,
      }),
    ).rejects.toThrow("restrict its access instead");
    const restricted = await db.setSkillHubNamespaceAccessState({
      namespace: "global",
      accessState: "restricted",
      expectedUpdatedAt: 2,
      reason: "disable default explicitly",
      actorUserId: admin.id,
      changedAt: 4,
    });
    db.close();
    stores.splice(stores.indexOf(db), 1);
    const restarted = open(databasePath);
    await restarted.ensureDefaultSkillHubNamespace({ actorUserId: member.id, changedAt: 5 });
    await expect(restarted.getSkillHubNamespaceBinding("global")).resolves.toEqual(restricted);
    const custom = await restarted.setSkillHubNamespaceBinding({
      namespace: "company",
      scopeKind: "global",
      accessState: "restricted",
      visibilityCeiling: "NAMESPACE_ONLY",
      expectedUpdatedAt: null,
      reason: "custom Global fixture",
      actorUserId: admin.id,
      changedAt: 6,
    });
    await expect(
      restarted.removeSkillHubNamespaceBinding({
        namespace: "company",
        expectedUpdatedAt: custom.updatedAt,
        reason: "retire custom Global",
        actorUserId: admin.id,
        changedAt: 7,
      }),
    ).resolves.toBe(true);
  });

  it("reserves one creator atomically and resumes the same operation after uncertainty", async () => {
    const { db, databasePath } = fixture();
    const member = (await db.upsertPrincipal(principal("member.user"), 1)).user;
    const other = (await db.upsertPrincipal(principal("other.user"), 2)).user;
    const request = {
      namespace: "new-tools",
      operationId: "operation-one",
      actorUserId: member.id,
      scopeKind: "global" as const,
      changedAt: 3,
    };
    const results = await Promise.allSettled([
      db.beginSkillHubNamespaceCreation(request),
      db.beginSkillHubNamespaceCreation({
        ...request,
        actorUserId: other.id,
        operationId: "operation-two",
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    await db.recordSkillHubNamespaceCreation({
      namespace: request.namespace,
      operationId: request.operationId,
      state: "uncertain",
      changedAt: 4,
    });
    db.close();
    stores.splice(stores.indexOf(db), 1);
    const restarted = open(databasePath);
    const resumed = await restarted.beginSkillHubNamespaceCreation({
      ...request,
      operationId: "must-not-replace-marker",
      changedAt: 5,
    });
    expect(resumed).toMatchObject({ operationId: "operation-one", state: "uncertain" });
    await expect(restarted.getSkillHubNamespaceBinding(request.namespace)).resolves.toBeNull();
    await restarted.recordSkillHubNamespaceCreation({
      namespace: request.namespace,
      operationId: resumed.operationId,
      state: "registry-created",
      registryNamespaceId: 12,
      changedAt: 6,
    });
    await expect(
      restarted.completeSkillHubNamespaceCreation({
        namespace: request.namespace,
        operationId: resumed.operationId,
        changedAt: 7,
      }),
    ).resolves.toMatchObject({ accessState: "active", visibilityCeiling: "NAMESPACE_ONLY" });
    await expect(restarted.listCompletedSkillHubNamespaces()).resolves.toEqual([request.namespace]);
    await expect(
      restarted.beginSkillHubNamespaceCreation({ ...request, changedAt: 8 }),
    ).resolves.toMatchObject({ state: "completed" });
  });

  it("rechecks managed-scope membership before activation and preserves the recorded registry identity", async () => {
    const { db } = fixture();
    const admin = (await db.upsertPrincipal(principal("admin.user"), 1)).user;
    const member = (await db.upsertPrincipal(principal("member.user"), 2)).user;
    const team = await db.createManagedScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Product",
      createdAt: 3,
    });
    const membership = {
      actorUserId: admin.id,
      scopeId: team.id,
      userId: member.id,
      role: "member" as const,
      reason: "creation fixture",
      changedAt: 4,
    };
    const request = {
      namespace: "team-tools",
      operationId: "operation-team",
      actorUserId: member.id,
      scopeKind: "team" as const,
      scopeId: team.id,
      changedAt: 5,
    };
    await expect(db.beginSkillHubNamespaceCreation(request)).rejects.toThrow(
      "publish authority required",
    );
    await db.setManagedScopeMembership(membership);
    await db.beginSkillHubNamespaceCreation(request);
    await db.recordSkillHubNamespaceCreation({
      namespace: request.namespace,
      operationId: request.operationId,
      state: "registry-created",
      registryNamespaceId: 14,
      changedAt: 6,
    });
    await db.removeManagedScopeMembership({
      actorUserId: admin.id,
      scopeId: team.id,
      userId: member.id,
      reason: "revoked during network call",
      changedAt: 7,
    });
    await expect(
      db.completeSkillHubNamespaceCreation({
        namespace: request.namespace,
        operationId: request.operationId,
        changedAt: 8,
      }),
    ).rejects.toThrow("publish authority required");
    await expect(db.getSkillHubNamespaceBinding(request.namespace)).resolves.toBeNull();
    await expect(db.listSkillHubNamespaceCreations(member.id)).resolves.toContainEqual(
      expect.objectContaining({ state: "registry-created", registryNamespaceId: 14 }),
    );
    await db.setManagedScopeMembership({ ...membership, changedAt: 9 });
    await expect(
      db.completeSkillHubNamespaceCreation({
        namespace: request.namespace,
        operationId: request.operationId,
        changedAt: 10,
      }),
    ).resolves.toMatchObject({ scopeId: team.id });
  });

  it("does not claim administrator bindings or include them in the self-service snapshot", async () => {
    const { db } = fixture();
    const admin = (await db.upsertPrincipal(principal("admin.user"), 1)).user;
    const member = (await db.upsertPrincipal(principal("member.user"), 2)).user;
    await db.setSkillHubNamespaceBinding({
      namespace: "operator-space",
      scopeKind: "global",
      accessState: "restricted",
      visibilityCeiling: "PRIVATE",
      expectedUpdatedAt: null,
      reason: "operator-owned binding",
      actorUserId: admin.id,
      changedAt: 3,
    });
    const request = {
      namespace: "operator-space",
      operationId: "operation-member",
      actorUserId: member.id,
      scopeKind: "global" as const,
      changedAt: 4,
    };
    await expect(db.beginSkillHubNamespaceCreation(request)).rejects.toThrow(
      "already exists or is reserved",
    );
    await expect(db.listCompletedSkillHubNamespaces()).resolves.toEqual([]);
    await expect(db.getSkillHubNamespaceBinding(request.namespace)).resolves.toMatchObject({
      accessState: "restricted",
      visibilityCeiling: "PRIVATE",
    });
    await expect(
      db.beginSkillHubNamespaceCreation({ ...request, namespace: "global" }),
    ).rejects.toThrow("reserved");
  });
});
