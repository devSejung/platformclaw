import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlPlaneIdFactory } from "./contracts.js";
import { PLATFORMCLAW_CONTROL_SCHEMA_VERSION } from "./sqlite-schema.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const directories: string[] = [];

function ids(): ControlPlaneIdFactory {
  let value = 0;
  return {
    nextUserId: () => `user-${++value}`,
    nextBindingId: () => `binding-${++value}`,
    nextSessionId: () => `session-${++value}`,
    nextManagedScopeId: () => `scope-${++value}`,
    nextAuditEventId: () => `audit-${++value}`,
  };
}

async function activeUser(store: SqliteControlPlaneStore, accountId: string, at: number) {
  const { user } = await store.upsertPrincipal(
    { provider: "ldap", subject: accountId, accountId, employeeId: accountId },
    at,
  );
  const reserved = await store.reservePersonalAgent(user.id, at + 1);
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: at + 2,
  });
  return { user, binding };
}

function insertPage(
  db: DatabaseSync,
  params: {
    id: string;
    scopeKind: "global" | "group" | "part";
    scopeId?: string;
    title: string;
    content?: string;
    status?: "active" | "retired";
  },
) {
  db.prepare(
    `INSERT INTO organization_memory_pages
      (id, scope_kind, scope_id, title, content, provenance_json, revision, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', 1, ?, 1, 1)`,
  ).run(
    params.id,
    params.scopeKind,
    params.scopeId ?? null,
    params.title,
    params.content ?? `${params.title} body`,
    params.status ?? "active",
  );
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("organization memory read model", () => {
  it("enforces Global, direct scope, leader-child, archived, sibling, and agent boundaries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-org-memory-"));
    directories.push(directory);
    const databasePath = join(directory, "control.sqlite");
    const store = new SqliteControlPlaneStore({
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["admin"],
      idFactory: ids(),
    });
    const admin = await activeUser(store, "admin", 10);
    const member = await activeUser(store, "member", 20);
    const outsider = await activeUser(store, "outsider", 30);
    const team = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "team",
      name: "Company",
      createdAt: 39,
    });
    const group = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "Platform",
      parentScopeId: team.id,
      createdAt: 40,
    });
    const partA = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Runtime",
      parentScopeId: group.id,
      createdAt: 41,
    });
    const partB = await store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Product",
      parentScopeId: group.id,
      createdAt: 42,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: partA.id,
      userId: member.user.id,
      role: "member",
      reason: "test assignment",
      changedAt: 50,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: group.id,
      userId: admin.user.id,
      role: "leader",
      reason: "test assignment",
      changedAt: 51,
    });

    await store.searchOrganizationMemory({ agentId: member.binding.agentId, query: "policy" });
    const db = new DatabaseSync(databasePath);
    insertPage(db, { id: "global", scopeKind: "global", title: "Global policy" });
    insertPage(db, { id: "group", scopeKind: "group", scopeId: group.id, title: "Group policy" });
    insertPage(db, { id: "part-a", scopeKind: "part", scopeId: partA.id, title: "Runtime policy" });
    insertPage(db, { id: "part-b", scopeKind: "part", scopeId: partB.id, title: "Product policy" });
    insertPage(db, {
      id: "retired",
      scopeKind: "global",
      title: "Retired policy",
      status: "retired",
    });
    db.close();

    expect(
      (
        await store.searchOrganizationMemory({ agentId: member.binding.agentId, query: "policy" })
      ).map((hit) => hit.id),
    ).toEqual(["global", "part-a"]);
    expect(
      (await store.searchOrganizationMemory({ agentId: admin.binding.agentId, query: "policy" }))
        .map((hit) => hit.id)
        .toSorted(),
    ).toEqual(["global", "group", "part-a", "part-b"]);
    expect(
      (
        await store.searchOrganizationMemory({ agentId: outsider.binding.agentId, query: "policy" })
      ).map((hit) => hit.id),
    ).toEqual(["global"]);
    await expect(
      store.searchOrganizationMemory({ agentId: "foreign", query: "policy" }),
    ).rejects.toThrow("active personal agent required");
    expect(
      await store.getOrganizationMemory({
        agentId: member.binding.agentId,
        path: "organization/part/part-b",
      }),
    ).toBeNull();
    expect(
      JSON.stringify(
        await store.getOrganizationMemory({
          agentId: member.binding.agentId,
          path: "organization/part/part-a",
        }),
      ),
    ).not.toContain(databasePath);

    await store.removeManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: partA.id,
      userId: member.user.id,
      changedAt: 55,
    });
    expect(
      await store.getOrganizationMemory({
        agentId: member.binding.agentId,
        path: "organization/part/part-a",
      }),
    ).toBeNull();

    await store.archiveManagedScope({
      actorUserId: admin.user.id,
      scopeId: partA.id,
      reason: "retire part",
      archivedAt: 60,
    });
    expect(
      (
        await store.searchOrganizationMemory({ agentId: member.binding.agentId, query: "policy" })
      ).map((hit) => hit.id),
    ).toEqual(["global"]);
    const schemaDb = new DatabaseSync(databasePath);
    expect(schemaDb.prepare("PRAGMA user_version").get()).toEqual({
      user_version: PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
    });
    schemaDb.close();
    expect("createOrganizationMemory" in store).toBe(false);
    await store.transitionAgent({
      bindingId: outsider.binding.id,
      state: "disabled",
      changedAt: 70,
    });
    await expect(
      store.searchOrganizationMemory({ agentId: outsider.binding.agentId, query: "policy" }),
    ).rejects.toThrow("active personal agent required");
    store.close();
  });
});
