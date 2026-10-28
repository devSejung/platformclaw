import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SkillHubGovernanceError } from "./skill-hub-governance-client.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const THIRTY_DAYS = 30 * 24 * 60 * 60_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function reserve(
  f: { store: SqliteControlPlaneStore; actor: { user: { id: string } } },
  index = 0,
) {
  return await f.store.skillHubCatalog.reservePublication({
    operationId: randomUUID(),
    actorUserId: f.actor.user.id,
    slug: `pending-${index}`,
    version: "1.0.0",
    fingerprint: `fixed-${index}`,
    now: 10,
    summary: "Pending package description",
  });
}

describe("Skill Hub durable maintenance", () => {
  it("does not claim physical erasure for an unknown failed first publication", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    f.governanceMocks.reserveArtifactIdentity.mockRejectedValue(
      new SkillHubGovernanceError("Native reservation unavailable", 503),
    );
    const { entry, receipt } = await reserve(f);
    await f.store.skillHubCatalog.cancelPublication({
      operationId: receipt.operationId,
      actorUserId: f.actor.user.id,
      now: 100 - THIRTY_DAYS,
    });
    expect(await f.service.processGovernanceQueue()).toEqual({ processed: 0 });
    expect(await f.store.skillHubCatalog.get(entry.id)).toMatchObject({
      registryId: null,
      purgedAt: null,
      purgePending: true,
      summary: "Pending package description",
    });
    expect(f.governanceMocks.deleteArtifact).not.toHaveBeenCalled();
    expect((await f.service.config(f.actor)).maintenanceError).toContain("cleanup is pending");
  });

  it("purges a real first publication cancelled before native reservation once 30 days pass", async () => {
    let now = 100;
    const f = await fixture([], undefined, { registrySkill: "absent", now: () => now });
    const operationId = randomUUID();
    f.governanceMocks.reserveArtifactIdentity.mockRejectedValueOnce(
      new SkillHubGovernanceError("Synthetic unavailable before native reservation", 503),
    );
    await expect(
      f.service.publish(f.actor, { operationId, skill: "demo-skill", version: "1.2.3" }),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(f.native.size).toBe(0);
    expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
    await expect(f.service.cancelPublication(f.actor.user, operationId)).resolves.toEqual({
      ok: true,
    });
    now += THIRTY_DAYS - 1;
    expect(await f.service.processGovernanceQueue()).toEqual({ processed: 0 });
    expect(f.governanceMocks.deleteArtifact).not.toHaveBeenCalled();
    now += 1;
    const remove = f.governanceMocks.deleteArtifact.getMockImplementation()!;
    f.governanceMocks.deleteArtifact.mockImplementation(async (identity) => {
      expect((await f.store.skillHubCatalog.get(operationId))?.registryId).toBe(identity.skillId);
      return await remove(identity);
    });
    expect(await f.service.processGovernanceQueue()).toEqual({ processed: 1 });
    expect(await f.store.skillHubCatalog.get(operationId)).toMatchObject({
      registryId: expect.any(Number),
      purgedAt: now,
      summary: "",
      currentVersion: null,
    });
    expect(f.native.size).toBe(0);
    expect(f.governanceMocks.deleteArtifact).toHaveBeenCalledOnce();
  });

  it("keeps a missing known native ID pending without creating another identity or accepting a lookup miss", async () => {
    const f = await fixture();
    const entry = f.entry!;
    await f.store.skillHubCatalog.trash({
      skillId: entry.id,
      actorUserId: f.actor.user.id,
      expectedRevision: entry.revision,
      now: 100 - THIRTY_DAYS,
    });
    f.native.delete(`${entry.namespace}/${entry.slug}`);
    expect(await f.service.processGovernanceQueue()).toEqual({ processed: 0 });
    expect(await f.store.skillHubCatalog.get(entry.id)).toMatchObject({
      registryId: entry.registryId,
      purgedAt: null,
      purgePending: true,
    });
    expect(f.governanceMocks.reserveArtifactIdentity).not.toHaveBeenCalled();
  });

  it("persists the discovered first-publication identity before deletion and recovers its lost reply", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const { entry, receipt } = await reserve(f);
    await f.store.skillHubCatalog.cancelPublication({
      operationId: receipt.operationId,
      actorUserId: f.actor.user.id,
      now: 100 - THIRTY_DAYS,
    });
    f.native.set(`${entry.namespace}/${entry.slug}`, {
      id: 77,
      namespace: entry.namespace,
      slug: entry.slug,
      displayName: "",
      summary: "",
      visibility: "PRIVATE",
      status: "ACTIVE",
      managedPublicationId: entry.id,
    });
    f.governanceMocks.deleteArtifact.mockImplementation(async ({ skillId }) => {
      expect((await f.store.skillHubCatalog.get(entry.id))?.registryId).toBe(77);
      f.native.delete(`${entry.namespace}/${entry.slug}`);
      f.deletions.set(skillId, {
        skillId,
        state: "completed",
        completedAt: new Date(90).toISOString(),
      });
      throw new SkillHubGovernanceError("Synthetic lost deletion reply");
    });
    expect(await f.service.processGovernanceQueue()).toEqual({ processed: 0 });
    expect(await f.store.skillHubCatalog.get(entry.id)).toMatchObject({
      registryId: 77,
      purgedAt: null,
    });
    expect(await f.service.processGovernanceQueue()).toEqual({ processed: 1 });
    expect(await f.store.skillHubCatalog.get(entry.id)).toMatchObject({
      registryId: 77,
      purgedAt: 100,
      summary: "",
    });
    expect(f.governanceMocks.deleteArtifact).toHaveBeenCalledOnce();
  });

  it("reconciles later committed publications beyond a persistently unresolved first batch", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const entries = [];
    for (let index = 0; index < 21; index++) {
      entries.push(await reserve(f, index));
    }
    entries.sort((left, right) =>
      left.receipt.operationId.localeCompare(right.receipt.operationId),
    );
    const last = entries.at(-1)!.entry;
    f.native.set(`${last.namespace}/${last.slug}`, {
      id: 77,
      namespace: last.namespace,
      slug: last.slug,
      displayName: last.slug,
      summary: "",
      visibility: "PRIVATE",
      status: "ACTIVE",
      managedPublicationId: last.id,
    });
    f.nativeVersions.set(`${last.namespace}/${last.slug}`, new Set(["1.0.0"]));
    expect(await f.service.processGovernanceQueue()).toEqual({ processed: 0 });
    expect(await f.service.processGovernanceQueue()).toEqual({ processed: 1 });
    expect((await f.store.skillHubCatalog.get(last.id))?.currentVersion).toBe("1.0.0");
  });

  it("purges later due artifacts beyond a persistently failing first batch", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const entries = [];
    for (let index = 0; index < 21; index++) {
      const entry = await f.seedEntry({ slug: `purge-${index}` });
      entries.push(
        await f.store.skillHubCatalog.trash({
          skillId: entry.id,
          actorUserId: f.actor.user.id,
          expectedRevision: entry.revision,
          now: 100 - THIRTY_DAYS,
        }),
      );
    }
    entries.sort((left, right) => left.id.localeCompare(right.id));
    const failed = new Set(entries.slice(0, 20).map((entry) => entry.registryId));
    const remove = f.governanceMocks.deleteArtifact.getMockImplementation()!;
    f.governanceMocks.deleteArtifact.mockImplementation(async (identity) => {
      if (failed.has(identity.skillId)) {
        throw new SkillHubGovernanceError("Synthetic persistent storage failure");
      }
      return await remove(identity);
    });
    expect(await f.service.processGovernanceQueue()).toEqual({ processed: 0 });
    expect(await f.service.processGovernanceQueue()).toEqual({ processed: 1 });
    expect((await f.store.skillHubCatalog.get(entries.at(-1)!.id))?.purgedAt).toBe(100);
  });

  it.each(["publication", "purge"] as const)(
    "persists %s cursor rotation across a new SQLite owner without duplicating wrapped rows",
    async (kind) => {
      // This is the SQLite owner's restart contract. A service fixture also
      // starts maintenance timers, which would introduce another cursor consumer.
      const databasePath = path.join(tempDirs.make("skillhub-cursor-"), "control.sqlite");
      const store = new SqliteControlPlaneStore({
        databasePath,
        initialAdminAccountIds: ["admin.user"],
        buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      });
      let first: string[];
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
        expect(user.globalRole).toBe("member");
        for (let index = 0; index < 25; index++) {
          const { entry, receipt } = await reserve({ store, actor: { user } }, index);
          if (kind === "purge") {
            await store.skillHubCatalog.cancelPublication({
              operationId: receipt.operationId,
              actorUserId: user.id,
              now: 100 - THIRTY_DAYS,
            });
          }
          expect(entry.id).toBe(receipt.skillId);
        }
        first =
          kind === "publication"
            ? (await store.skillHubCatalog.claimPendingPublications(20)).map(
                (item) => item.operationId,
              )
            : (await store.skillHubCatalog.claimPurgeDue(100, 20)).map((item) => item.id);
      } finally {
        store.close();
      }
      const reopened = new SqliteControlPlaneStore({
        databasePath,
        buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      });
      try {
        const second =
          kind === "publication"
            ? (await reopened.skillHubCatalog.claimPendingPublications(20)).map(
                (item) => item.operationId,
              )
            : (await reopened.skillHubCatalog.claimPurgeDue(100, 20)).map((item) => item.id);
        expect(first).toHaveLength(20);
        expect(second).toHaveLength(20);
        expect(new Set(second).size).toBe(20);
        expect(new Set([...first, ...second]).size).toBe(25);
        expect(second.slice(0, 5).every((id) => !first.includes(id))).toBe(true);
      } finally {
        reopened.close();
      }
    },
  );
});
