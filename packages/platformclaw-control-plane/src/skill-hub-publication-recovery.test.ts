import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SkillHubCatalogStore } from "./skill-hub-catalog-state.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function reserve(catalog: SkillHubCatalogStore, actorUserId: string, index: number) {
  const operationId = randomUUID();
  return await catalog.reservePublication({
    operationId,
    actorUserId,
    slug: `recovery-${index}`,
    version: "1.0.0",
    fingerprint: operationId,
    now: index,
  });
}

describe("Skill Hub publication recovery visibility", () => {
  it("shows a member's first pending upload after twenty older uploads from another member", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const other = await f.createActor("other.member");
    for (let index = 0; index < 20; index++) {
      await reserve(f.store.skillHubCatalog, other.user.id, index);
    }
    const own = await reserve(f.store.skillHubCatalog, f.actor.user.id, 21);
    expect(await f.store.skillHubCatalog.listPendingPublications()).toHaveLength(20);
    expect((await f.service.config(f.actor)).pendingPublications).toEqual([
      expect.objectContaining({
        operationId: own.receipt.operationId,
        displayName: "recovery-21",
        slug: "recovery-21",
        isMine: true,
      }),
    ]);
    // An incomplete first upload cannot be found through the published library.
    expect((await f.service.search(f.actor.user, "")).items).toEqual([]);
    expect((await f.service.config(f.actor)).ownedSkills).toEqual([]);
  });

  it("shows every outstanding owned publication without disclosing other members' recovery records", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const other = await f.createActor("other.member");
    const ids: string[] = [];
    for (let index = 0; index < 25; index++) {
      ids.push(
        (await reserve(f.store.skillHubCatalog, f.actor.user.id, index)).receipt.operationId,
      );
    }
    const pending = (await f.service.config(f.actor)).pendingPublications;
    expect(pending.map((item) => item.operationId)).toEqual(ids);
    expect(pending.every((item) => item.isMine)).toBe(true);
    expect(pending.every((item) => !("ownerUserId" in item))).toBe(true);
    expect((await f.service.config(other)).pendingPublications).toEqual([]);
    const admin = await f.createActor("admin.user");
    expect((await f.service.config(admin)).pendingPublications).toEqual(
      ids.map((operationId) => expect.objectContaining({ operationId, isMine: false })),
    );
  });

  it("lets the current ordinary owner recover an administrator's pending publication", async () => {
    const f = await fixture();
    const admin = await f.createActor("admin.user");
    const other = await f.createActor("other.member");
    const entry = await f.store.skillHubCatalog.updateMetadata({
      skillId: f.entry!.id,
      actorUserId: f.actor.user.id,
      expectedRevision: f.entry!.revision,
      displayName: "Saved release checklist",
      now: 20,
    });
    const operationId = randomUUID();
    await f.store.skillHubCatalog.reservePublication({
      operationId,
      skillId: entry.id,
      actorUserId: admin.user.id,
      slug: entry.slug,
      version: "3.0.0",
      fingerprint: operationId,
      expectedRevision: entry.revision,
      reason: "Owner requested a new version",
      now: 30,
    });
    expect((await f.service.config(f.actor)).pendingPublications).toEqual([
      expect.objectContaining({
        operationId,
        actorUserId: admin.user.id,
        displayName: "Saved release checklist",
        slug: "demo-skill",
        isMine: true,
      }),
    ]);
    expect((await f.service.config(admin)).pendingPublications).toEqual([
      expect.objectContaining({ operationId, isMine: false }),
    ]);
    expect((await f.service.config(other)).pendingPublications).toEqual([]);
    await expect(f.service.cancelPublication(other.user, operationId)).rejects.toThrow(
      "owner or administrator",
    );
    // The same response flag makes the existing UI show an administrator reason.
    await expect(f.service.cancelPublication(admin.user, operationId)).rejects.toThrow(
      "require a reason",
    );
    await expect(f.service.cancelPublication(f.actor.user, operationId)).resolves.toEqual({
      ok: true,
    });
    expect((await f.service.config(f.actor)).pendingPublications).toEqual([]);
    expect((await f.store.skillHubCatalog.get(entry.id))?.currentVersion).toBe(
      entry.currentVersion,
    );
  });

  it("uses current ownership rather than the former owner or original publisher", async () => {
    const f = await fixture();
    const next = await f.createActor("next.owner");
    const admin = await f.createActor("admin.user");
    const entry = f.entry!;
    const offered = await f.store.skillHubCatalog.requestTransfer({
      skillId: entry.id,
      actorUserId: f.actor.user.id,
      expectedRevision: entry.revision,
      recipientUserId: next.user.id,
      now: 20,
    });
    const owned = await f.store.skillHubCatalog.acceptTransfer({
      skillId: entry.id,
      actorUserId: next.user.id,
      expectedRevision: offered.revision,
      now: 21,
    });
    const operationId = randomUUID();
    await f.store.skillHubCatalog.reservePublication({
      operationId,
      skillId: entry.id,
      actorUserId: admin.user.id,
      slug: entry.slug,
      version: "3.0.0",
      fingerprint: operationId,
      expectedRevision: owned.revision,
      reason: "Current owner requested help",
      now: 30,
    });
    expect((await f.service.config(f.actor)).pendingPublications).toEqual([]);
    expect((await f.service.config(next)).pendingPublications).toEqual([
      expect.objectContaining({ operationId, isMine: true }),
    ]);
    await expect(f.service.cancelPublication(f.actor.user, operationId)).rejects.toThrow(
      "owner or administrator",
    );
    await f.service.cancelPublication(admin.user, operationId, "Cancel the interrupted upload");
    expect(
      await f.store.skillHubCatalog.listHistory({ skillId: entry.id, actorUserId: admin.user.id }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: admin.user.id,
          action: "publication-cancelled",
          details: { reason: "Cancel the interrupted upload" },
        }),
      ]),
    );
  });

  it("revalidates administrative role and active-account authority in the recovery query", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const admin = await f.createActor("admin.user");
    const backup = await f.createActor("backup.admin");
    await f.store.setUserGlobalRole({
      actorUserId: admin.user.id,
      targetUserId: backup.user.id,
      role: "admin",
      changedAt: 30,
    });
    await reserve(f.store.skillHubCatalog, f.actor.user.id, 1);
    expect(await f.store.skillHubCatalog.listRecoverablePublications(admin.user.id)).toHaveLength(
      1,
    );
    await f.store.setUserGlobalRole({
      actorUserId: backup.user.id,
      targetUserId: admin.user.id,
      role: "member",
      changedAt: 31,
    });
    expect((await f.service.config(admin)).pendingPublications).toEqual([]);
    await f.store.setManagedUserStatus({
      actorUserId: backup.user.id,
      targetUserId: f.actor.user.id,
      status: "disabled",
      changedAt: 32,
    });
    await expect(
      f.store.skillHubCatalog.listRecoverablePublications(f.actor.user.id),
    ).rejects.toThrow("Active Skill Hub account required");
  });

  it("retains all manager-scoped recovery records across a SQLite restart", async () => {
    const databasePath = path.join(tempDirs.make("skillhub-recovery-"), "control.sqlite");
    const store = new SqliteControlPlaneStore({
      databasePath,
      initialAdminAccountIds: ["admin.user"],
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
    const ids: string[] = [];
    let ownerId: string;
    try {
      await store.upsertPrincipal(
        {
          provider: "ldap",
          subject: "admin.user",
          accountId: "admin.user",
          employeeId: "admin.user",
          groups: [],
        },
        1,
      );
      const { user } = await store.upsertPrincipal(
        {
          provider: "ldap",
          subject: "member.user",
          accountId: "member.user",
          employeeId: "member.user",
          groups: [],
        },
        1,
      );
      ownerId = user.id;
      for (let index = 0; index < 25; index++) {
        ids.push((await reserve(store.skillHubCatalog, ownerId, index)).receipt.operationId);
      }
    } finally {
      store.close();
    }
    const reopened = new SqliteControlPlaneStore({
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
    try {
      expect(
        (await reopened.skillHubCatalog.listRecoverablePublications(ownerId)).map(
          (item) => item.operationId,
        ),
      ).toEqual(ids);
    } finally {
      reopened.close();
    }
  });
});
