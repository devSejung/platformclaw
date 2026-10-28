import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const sourceAt = Date.parse("2026-10-20T01:00:00Z");
const stores: SqliteControlPlaneStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function createUser(store: SqliteControlPlaneStore, accountId: string) {
  return (
    await store.upsertPrincipal(
      { provider: "ldap", subject: accountId, accountId, employeeId: accountId },
      sourceAt,
    )
  ).user;
}

function synchronize(
  store: SqliteControlPlaneStore,
  userId: string,
  overrides: {
    part?: { id: string; name: string };
    group?: { id: string; name: string };
    team?: string;
    sourceOffset?: number;
  } = {},
) {
  return store.syncDirectoryOrganization({
    userId,
    org: {
      version: 1,
      source: "aicm",
      part: overrides.part ?? { id: "runtime", name: "Runtime" },
      group: overrides.group ?? { id: "platform", name: "Platform" },
      team: overrides.team ?? "Engineering",
      updatedAt: new Date(sourceAt + (overrides.sourceOffset ?? 0)).toISOString(),
    },
    isTestAccount: false,
    syncedAt: sourceAt + 100_000 + (overrides.sourceOffset ?? 0),
  });
}

async function externalScope(store: SqliteControlPlaneStore, key: string) {
  const scope = (await store.listManagedScopes()).find((entry) => entry.externalKey === key);
  expect(scope, key).toBeDefined();
  return scope!;
}

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "platformclaw-directory-access-")));
  directories.push(directory);
  const store = new SqliteControlPlaneStore({
    databasePath: join(directory, "control.sqlite"),
    initialAdminAccountIds: ["admin"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  stores.push(store);
  const admin = await createUser(store, "admin");
  const member = await createUser(store, "member");
  await synchronize(store, member.id);
  const part = await externalScope(store, "aicm-part:runtime");
  const group = await externalScope(store, "group:platform");
  const team = await externalScope(store, "team:Engineering");
  return { store, admin, member, part, group, team };
}

describe("directory synchronization access lifecycle", () => {
  it.each([
    { manual: false, connected: true },
    { manual: true, connected: true },
    { manual: true, connected: false },
  ])(
    "preserves manual Wiki and primary choices during an automatic move: %j",
    async ({ manual, connected }) => {
      const { store, admin, member, part } = await fixture();
      if (manual) {
        await store.setManagedScopeMembership({
          actorUserId: admin.id,
          userId: member.id,
          scopeId: part.id,
          role: "leader",
          reason: "Retain cross-part responsibility",
          changedAt: sourceAt + 101_000,
        });
      }
      await store.setUserPrimaryScope({
        actorUserId: member.id,
        userId: member.id,
        scopeId: part.id,
        changedAt: sourceAt + 102_000,
      });
      const vault = store.vaults.createVault({ userId: admin.id, name: "Runtime Wiki" });
      store.vaults.setOrganizationGrant({
        userId: admin.id,
        vaultId: vault.id,
        scopeId: part.id,
        role: "reader",
      });
      expect(store.vaults.connectionScope(member.id).vaultIds).toEqual([vault.id]);
      if (!connected) {
        store.vaults.setConnection({ userId: member.id, vaultId: vault.id, connected: false });
      }
      const before = store.vaults.connectionScope(member.id);

      await expect(
        synchronize(store, member.id, {
          part: { id: "tools", name: "Tools" },
          sourceOffset: 1_000,
        }),
      ).resolves.toMatchObject({ status: "synced" });

      const after = store.vaults.connectionScope(member.id);
      if (manual) {
        expect(after).toEqual(before);
        expect(
          store.vaults.snapshot({ userId: member.id, vaultId: vault.id }).selected,
        ).toBeDefined();
        expect(await store.getUserPrimaryScope(member.id)).toMatchObject({ id: part.id });
        expect(await store.listUserManagedScopeMemberships(member.id)).toEqual(
          expect.arrayContaining([expect.objectContaining({ scopeId: part.id, role: "leader" })]),
        );
      } else {
        expect(after.vaultIds).toEqual([]);
        expect(after.revision).toBeGreaterThan(before.revision);
        expect(() => store.vaults.snapshot({ userId: member.id, vaultId: vault.id })).toThrow(
          "unavailable",
        );
        expect(await store.getUserPrimaryScope(member.id)).toBeNull();
      }
    },
  );

  it("reparents ancestor access without expanding Wiki grants or exposing sibling parts", async () => {
    const { store, admin, member, part, group, team } = await fixture();
    const colleague = await createUser(store, "colleague");
    const siblingMember = await createUser(store, "sibling");
    await synchronize(store, colleague.id);
    await synchronize(store, siblingMember.id, { part: { id: "sibling", name: "Sibling" } });
    const sibling = await externalScope(store, "aicm-part:sibling");
    const directVault = store.vaults.createVault({ userId: admin.id, name: "Part Wiki" });
    const groupVault = store.vaults.createVault({ userId: admin.id, name: "Group Wiki" });
    store.vaults.setOrganizationGrant({
      userId: admin.id,
      vaultId: directVault.id,
      scopeId: part.id,
      role: "reader",
    });
    store.vaults.setOrganizationGrant({
      userId: admin.id,
      vaultId: groupVault.id,
      scopeId: group.id,
      role: "reader",
    });
    expect(() => store.vaults.snapshot({ userId: member.id, vaultId: groupVault.id })).toThrow(
      "unavailable",
    );
    store.vaults.setConnection({ userId: member.id, vaultId: directVault.id, connected: false });
    const wikiChoice = store.vaults.connectionScope(member.id);

    await synchronize(store, member.id, {
      group: { id: "services", name: "Services" },
      team: "Technology",
      sourceOffset: 1_000,
    });
    const nextGroup = await externalScope(store, "group:services");
    const nextTeam = await externalScope(store, "team:Technology");
    for (const target of [member, colleague]) {
      const access = (await store.listEffectiveManagedScopeAccess(target.id)).map(
        (entry) => entry.scope.id,
      );
      expect(access.toSorted()).toEqual([part.id, nextGroup.id, nextTeam.id].toSorted());
      expect((await store.resolveManagedScopeAuthorization(target.id, sibling.id)).canRead).toBe(
        false,
      );
      expect(
        store.vaults.snapshot({ userId: target.id, vaultId: directVault.id }).selected,
      ).toBeDefined();
    }
    expect(store.vaults.connectionScope(member.id)).toEqual(wikiChoice);
    expect(
      (await store.listEffectiveManagedScopeAccess(siblingMember.id))
        .map((entry) => entry.scope.id)
        .toSorted(),
    ).toEqual([sibling.id, group.id, team.id].toSorted());
    expect((await store.resolveManagedScopeAuthorization(siblingMember.id, part.id)).canRead).toBe(
      false,
    );
  });

  it("ends a pending join request when directory authority supplies its membership", async () => {
    const { store, member } = await fixture();
    const colleague = await createUser(store, "colleague");
    await synchronize(store, colleague.id, {
      part: { id: "tools", name: "Tools" },
      sourceOffset: 1_000,
    });
    const tools = await externalScope(store, "aicm-part:tools");
    await store.submitOrganizationJoinRequest({
      requestId: "join-tools",
      userId: member.id,
      scopeId: tools.id,
      reason: "Join my new part",
      submittedAt: sourceAt + 101_000,
    });
    await synchronize(store, member.id, {
      part: { id: "tools", name: "Tools" },
      sourceOffset: 2_000,
    });
    expect(await store.listOwnOrganizationJoinRequests({ userId: member.id })).toMatchObject([
      {
        id: "join-tools",
        status: "cancelled",
        decisionReason: "Membership supplied by ldap-login",
      },
    ]);
    expect(await store.listUserManagedScopeMemberships(member.id)).toMatchObject([
      { scopeId: tools.id, managedBy: "ldap-login" },
    ]);
  });

  it("preserves Skill Hub ownership while current directory membership changes its audience", async () => {
    const { store, admin, member, part, group } = await fixture();
    const leader = await createUser(store, "leader");
    await store.setManagedScopeMembership({
      actorUserId: admin.id,
      userId: leader.id,
      scopeId: group.id,
      role: "leader",
      reason: "Manage the original group",
      changedAt: sourceAt + 101_000,
    });
    const catalog = store.skillHubCatalog;
    const entries = [];
    for (const [index, owner] of [leader, member].entries()) {
      const operationId = randomUUID();
      const reserved = await catalog.reservePublication({
        operationId,
        actorUserId: owner.id,
        slug: `directory-skill-${index}`,
        version: "1.0.0",
        fingerprint: operationId,
        sharing: { mode: "SELECTED", userIds: [], scopeIds: [part.id] },
        now: sourceAt + 102_000,
      });
      entries.push(
        await catalog.completePublication({
          operationId: reserved.receipt.operationId,
          registryId: 100 + index,
          now: sourceAt + 103_000,
        }),
      );
    }
    expect(await catalog.canAccess({ skillId: entries[0]!.id, userId: member.id })).toBe(true);
    await synchronize(store, member.id, {
      group: { id: "services", name: "Services" },
      team: "Technology",
      sourceOffset: 1_000,
    });
    expect(
      (await store.resolveManagedScopeAuthorization(leader.id, part.id)).canManageMembers,
    ).toBe(false);
    expect((await catalog.get(entries[0]!.id))?.ownerUserId).toBe(leader.id);
    expect((await catalog.get(entries[1]!.id))?.ownerUserId).toBe(member.id);
    expect(await catalog.canAccess({ skillId: entries[0]!.id, userId: member.id })).toBe(true);
    await synchronize(store, member.id, {
      part: { id: "tools", name: "Tools" },
      group: { id: "services", name: "Services" },
      team: "Technology",
      sourceOffset: 2_000,
    });
    expect(await catalog.canAccess({ skillId: entries[0]!.id, userId: member.id })).toBe(false);
    expect(await catalog.canAccess({ skillId: entries[1]!.id, userId: member.id })).toBe(true);
    expect((await catalog.get(entries[1]!.id))?.ownerUserId).toBe(member.id);
    expect(await store.countUnreadSkillHubNotifications(admin.id)).toBe(0);
  });
});
