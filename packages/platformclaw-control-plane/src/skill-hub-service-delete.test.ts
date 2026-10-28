import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillHubAdapterError } from "./skill-hub-adapter.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

const THIRTY_DAYS = 30 * 24 * 60 * 60_000;
const YEAR = 365 * 24 * 60 * 60_000;

async function dueFixture() {
  const result = await fixture([], undefined, { registrySkill: "absent" });
  const entry = await result.seedEntry();
  await result.store.skillHubCatalog.trash({
    skillId: entry.id,
    actorUserId: result.actor.user.id,
    expectedRevision: entry.revision,
    now: 100 - THIRTY_DAYS,
  });
  return { ...result, entry };
}

describe("SkillHubService trash and permanent deletion", () => {
  it("trashes only the catalog copy, keeps installed/workspace bytes, and restores the exact sharing", async () => {
    const { service, actor, adapterMocks, store, adminRpcCall, seedEntry, skillDir } =
      await fixture([], undefined, { registrySkill: "absent" });
    const entry = await seedEntry({ sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] } });
    const origin = await store.skillHubCatalog.recordInstallation({
      agentId: actor.agentId,
      destination: "platform_server",
      targetId: "platform-server",
      slug: entry.slug,
      skillId: entry.id,
      version: "1.0.0",
      archiveSha256: "a".repeat(64),
      installedRevision: "sha256:0123456789abcdef",
      installedAt: 20,
      state: "completed",
    });
    adminRpcCall.mockClear();
    await expect(
      service.deletePublishedSkill(actor.user, entry.id, entry.revision),
    ).resolves.toMatchObject({ ok: true, id: entry.id, revision: entry.revision + 1 });
    expect(adapterMocks.deleteSkill).not.toHaveBeenCalled();
    expect(adminRpcCall).not.toHaveBeenCalled();
    expect(await readFile(path.join(skillDir, "helper.txt"), "utf8")).toBe("hello");
    expect(await store.skillHubCatalog.listInstallations(actor.agentId, "platform-server")).toEqual(
      [origin],
    );
    await expect(service.detailById(actor.user, entry.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect((await service.trash(actor.user)).items).toMatchObject([
      { id: entry.id, purgeAt: 100 + THIRTY_DAYS },
    ]);
    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 0 });
    await expect(service.restore(actor.user, entry.id, entry.revision + 1)).resolves.toMatchObject({
      ok: true,
      revision: entry.revision + 2,
    });
    expect(await store.skillHubCatalog.get(entry.id)).toMatchObject({
      sharing: entry.sharing,
      currentVersion: entry.currentVersion,
      deletedAt: null,
    });
  });

  it("requires the current owner and revision, and requires administrator reasons for intervention", async () => {
    const { service, actor, store, seedEntry, createActor, adapterMocks } = await fixture(
      [],
      undefined,
      { registrySkill: "absent" },
    );
    const entry = await seedEntry();
    const outsider = await createActor("outsider.user");
    const admin = await createActor("admin.user");
    await expect(
      service.deletePublishedSkill(outsider.user, entry.id, entry.revision),
    ).rejects.toThrow("owner or administrator");
    await expect(
      service.deletePublishedSkill(actor.user, entry.id, entry.revision - 1),
    ).rejects.toMatchObject({ code: "skill-hub-changed" });
    await expect(
      service.deletePublishedSkill(admin.user, entry.id, entry.revision),
    ).rejects.toThrow("require a reason");
    await expect(
      service.deletePublishedSkill(admin.user, randomUUID(), 1, "Remove unknown entry"),
    ).rejects.toMatchObject({ resource: "skill-hub-skill" });
    expect((await store.skillHubCatalog.get(entry.id))?.deletedAt).toBeNull();
    expect(adapterMocks.deleteSkill).not.toHaveBeenCalled();
    await service.deletePublishedSkill(
      admin.user,
      entry.id,
      entry.revision,
      "Owner requested removal",
    );
    expect(
      await store.skillHubCatalog.listHistory({ skillId: entry.id, actorUserId: admin.user.id }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "deleted",
          management: true,
          actorUserId: admin.user.id,
          details: { reason: "Owner requested removal" },
        }),
      ]),
    );
  });

  it("purges only after 30 days and retains content-free history for one year after actual purge", async () => {
    const { service, actor, store, adapterMocks, entry } = await dueFixture();
    expect(await store.skillHubCatalog.listPurgeDue(99)).toEqual([]);
    await expect(service.restore(actor.user, entry.id, entry.revision + 1)).rejects.toThrow(
      "no longer",
    );
    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 1 });
    expect(adapterMocks.deleteSkill).toHaveBeenCalledWith(entry.namespace, entry.slug);
    expect(await store.skillHubCatalog.get(entry.id)).toMatchObject({
      purgedAt: 100,
      currentVersion: null,
      displayName: "",
      summary: "",
      tags: [],
      sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
    });
    const history = await store.skillHubCatalog.listHistory({
      skillId: entry.id,
      actorUserId: actor.user.id,
    });
    expect(history.length).toBeGreaterThan(0);
    expect(
      history.every((event) => event.management && Object.keys(event.details).length === 0),
    ).toBe(true);
    expect(await store.skillHubCatalog.pruneHistory(100 + YEAR - 1)).toBe(0);
    expect(await store.skillHubCatalog.pruneHistory(100 + YEAR)).toBe(1);
    expect(await store.skillHubCatalog.get(entry.id)).toBeNull();
  });

  it("retains unavailable trash and visible cleanup failure when native deletion fails, then retries", async () => {
    const { service, actor, store, adapterMocks, entry } = await dueFixture();
    adapterMocks.deleteSkill.mockRejectedValueOnce(
      new SkillHubAdapterError("registry unavailable", 503),
    );
    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 0 });
    expect(await store.skillHubCatalog.get(entry.id)).toMatchObject({
      purgedAt: null,
      purgePending: true,
      summary: "Demo",
    });
    expect((await service.config(actor)).maintenanceError).toContain("cleanup is pending");
    await expect(service.detailById(actor.user, entry.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 1 });
    expect((await store.skillHubCatalog.get(entry.id))?.purgedAt).toBe(100);
    expect(adapterMocks.deleteSkill).toHaveBeenCalledTimes(2);
  });

  it("does not declare an ambiguous native deletion complete while the artifact still resolves", async () => {
    const { service, store, adapterMocks, entry } = await dueFixture();
    adapterMocks.deleteSkill.mockResolvedValue({
      ok: false,
      namespace: entry.namespace,
      slug: entry.slug,
    });
    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 0 });
    expect(await store.skillHubCatalog.get(entry.id)).toMatchObject({
      purgedAt: null,
      purgePending: true,
      summary: "Demo",
    });
  });

  it("continues later due deletions when the first native deletion fails", async () => {
    const { service, actor, store, adapterMocks, seedEntry } = await fixture([], undefined, {
      registrySkill: "absent",
    });
    const entry = await seedEntry();
    const second = await seedEntry({ slug: "second-due-skill" });
    await store.skillHubCatalog.trash({
      skillId: entry.id,
      actorUserId: actor.user.id,
      expectedRevision: entry.revision,
      now: 99 - THIRTY_DAYS,
    });
    await store.skillHubCatalog.trash({
      skillId: second.id,
      actorUserId: actor.user.id,
      expectedRevision: second.revision,
      now: 100 - THIRTY_DAYS,
    });
    // The first row is older; both are due at the fixture clock's current time.
    const deleteNative = adapterMocks.deleteSkill.getMockImplementation();
    if (!deleteNative) {
      throw new Error("Native delete fixture is unavailable");
    }
    adapterMocks.deleteSkill.mockImplementation(async (namespace, slug) => {
      if (namespace === entry.namespace && slug === entry.slug) {
        throw new SkillHubAdapterError("first registry artifact unavailable", 503);
      }
      return await deleteNative(namespace, slug);
    });
    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 1 });
    expect(await store.skillHubCatalog.get(entry.id)).toMatchObject({
      purgedAt: null,
      purgePending: true,
    });
    expect((await store.skillHubCatalog.get(second.id))?.purgedAt).toBe(100);
    expect(adapterMocks.deleteSkill).toHaveBeenCalledWith(second.namespace, second.slug);
  });

  it("keeps deletion pending when a native artifact disappears without a physical cleanup receipt", async () => {
    const { service, store, native, adapterMocks, entry } = await dueFixture();
    native.delete(`${entry.namespace}/${entry.slug}`);
    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 0 });
    expect(adapterMocks.deleteSkill).not.toHaveBeenCalled();
    expect((await store.skillHubCatalog.get(entry.id))?.purgedAt).toBeNull();
  });

  it("stops permanent deletion when a native coordinate has been replaced by another identity", async () => {
    const { service, store, native, adapterMocks, entry } = await dueFixture();
    const actual = native.get(`${entry.namespace}/${entry.slug}`);
    if (!actual) {
      throw new Error("Native fixture entry missing");
    }
    native.set(`${entry.namespace}/${entry.slug}`, { ...actual, id: actual.id + 10 });
    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 0 });
    expect(adapterMocks.deleteSkill).not.toHaveBeenCalled();
    expect(await store.skillHubCatalog.get(entry.id)).toMatchObject({
      purgedAt: null,
      purgePending: true,
    });
  });
  it("waits for physical cleanup and recovers a durable completed receipt", async () => {
    const { service, store, native, governanceMocks, deletions, entry } = await dueFixture();
    governanceMocks.deleteArtifact.mockImplementation(async ({ skillId }) => {
      native.delete(`${entry.namespace}/${entry.slug}`);
      const pending = { skillId, state: "pending" as const };
      deletions.set(skillId, pending);
      return pending;
    });
    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 0 });
    expect((await store.skillHubCatalog.get(entry.id))?.purgedAt).toBeNull();
    deletions.set(entry.registryId!, {
      skillId: entry.registryId!,
      state: "completed",
      completedAt: new Date(90).toISOString(),
    });
    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 1 });
    expect((await store.skillHubCatalog.get(entry.id))?.purgedAt).toBe(100);
    expect(governanceMocks.deleteArtifact).toHaveBeenCalledTimes(1);
  });
});
