import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../src/shared/deferred.js";
import { SkillHubAdapterError } from "./skill-hub-adapter.js";
import { SkillHubGovernanceError } from "./skill-hub-governance-client.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

describe("Skill Hub publication identity", () => {
  it("commits the reserved native ID before allowing archive publication", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    f.service.close();
    const entered = createDeferred();
    const release = createDeferred();
    const bind = f.store.skillHubCatalog.bindRegistryIdentity.bind(f.store.skillHubCatalog);
    vi.spyOn(f.store.skillHubCatalog, "bindRegistryIdentity").mockImplementation(async (params) => {
      entered.resolve();
      await release.promise;
      return await bind(params);
    });
    const nativePublish = f.governanceMocks.publishArtifact.getMockImplementation()!;
    f.governanceMocks.publishArtifact.mockImplementation(async (params) => {
      const [entry] = await f.store.skillHubCatalog.list();
      expect(entry?.registryId).toBe(params.expectedSkillId);
      expect(params.expectedSkillId).toBeGreaterThan(0);
      return await nativePublish(params);
    });
    const operationId = randomUUID();
    const publication = f.service.publish(f.actor, {
      operationId,
      skill: "demo-skill",
      version: "1.2.3",
    });
    await entered.promise;
    expect((await f.store.skillHubCatalog.get(operationId))?.registryId).toBeNull();
    expect(f.governanceMocks.reserveArtifactIdentity).toHaveBeenCalledOnce();
    expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
    expect(f.nativeVersions.size).toBe(0);
    release.resolve();
    await expect(publication).resolves.toMatchObject({ id: operationId });
    expect(f.governanceMocks.publishArtifact).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "recovers concurrent identical requests after a committed lost reply (existing=%s)",
    async (existing) => {
      const f = await fixture([], undefined, {
        registrySkill: existing ? "existing" : "absent",
      });
      f.service.close();
      const catalog = f.store.skillHubCatalog;
      const reserve = catalog.reservePublication.bind(catalog);
      const bothArrived = createDeferred();
      let arrivals = 0;
      vi.spyOn(catalog, "reservePublication").mockImplementation(async (params) => {
        if (++arrivals === 2) {
          bothArrived.resolve();
        }
        // Both requests must reach reservation before either native effect.
        // A separate receipt read can therefore report absent for both callers.
        await bothArrived.promise;
        return await reserve(params);
      });
      const nativePublish = f.governanceMocks.publishArtifact.getMockImplementation()!;
      f.governanceMocks.publishArtifact.mockImplementationOnce(async (params) => {
        await nativePublish(params);
        throw new SkillHubGovernanceError("Synthetic committed lost reply");
      });
      const operationId = randomUUID();
      const request = {
        operationId,
        ...(f.entry ? { id: f.entry.id, expectedRevision: f.entry.revision } : {}),
        skill: "demo-skill",
        version: "1.2.3",
      };
      const outcomes = await Promise.allSettled([
        f.service.publish(f.actor, request),
        f.service.publish(f.actor, request),
      ]);
      const skillId = f.entry?.id ?? operationId;
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toEqual([
        { status: "fulfilled", value: { id: skillId, slug: "demo-skill", version: "1.2.3" } },
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
        expect.objectContaining({ reason: expect.objectContaining({ statusCode: 502 }) }),
      ]);
      expect(f.governanceMocks.publishArtifact).toHaveBeenCalledOnce();
      expect(await catalog.getPublication(operationId)).toMatchObject({
        skillId,
        state: "completed",
      });
      expect(await catalog.get(skillId)).toMatchObject({
        ownerUserId: f.actor.user.id,
        sharing: f.entry?.sharing ?? { mode: "PUBLIC", userIds: [], scopeIds: [] },
        currentVersion: "1.2.3",
      });
      expect(
        (await catalog.listHistory({ skillId, actorUserId: f.actor.user.id })).filter(
          (item) => item.action === "version-published" && item.version === "1.2.3",
        ),
      ).toHaveLength(1);
    },
  );

  it("serializes cancellation behind an in-flight native publication and reports the committed outcome", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const entered = createDeferred();
    const release = createDeferred();
    const nativePublish = f.governanceMocks.publishArtifact.getMockImplementation()!;
    f.governanceMocks.publishArtifact.mockImplementation(async (params) => {
      entered.resolve();
      await release.promise;
      return await nativePublish(params);
    });
    const operationId = randomUUID();
    const publishing = f.service.publish(f.actor, {
      operationId,
      skill: "demo-skill",
      version: "1.2.3",
    });
    await entered.promise;
    let cancelled = false;
    const cancellation = f.service.cancelPublication(f.actor.user, operationId);
    const rejected = expect(cancellation).rejects.toThrow("already completed");
    void cancellation
      .finally(() => {
        cancelled = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    expect(cancelled).toBe(false);
    release.resolve();
    await expect(publishing).resolves.toMatchObject({ id: operationId });
    await rejected;
    expect((await f.store.skillHubCatalog.getPublication(operationId))?.state).toBe("completed");
    expect((await f.store.skillHubCatalog.get(operationId))?.currentVersion).toBe("1.2.3");
  });

  it("reconciles a committed lost-reply publication before refusing cancellation", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const nativePublish = f.governanceMocks.publishArtifact.getMockImplementation()!;
    f.governanceMocks.publishArtifact.mockImplementationOnce(async (params) => {
      await nativePublish(params);
      throw new SkillHubGovernanceError("Synthetic lost reply");
    });
    const operationId = randomUUID();
    await expect(
      f.service.publish(f.actor, { operationId, skill: "demo-skill", version: "1.2.3" }),
    ).rejects.toMatchObject({ statusCode: 502 });
    await expect(f.service.cancelPublication(f.actor.user, operationId)).rejects.toThrow(
      "already completed",
    );
    expect((await f.store.skillHubCatalog.getPublication(operationId))?.state).toBe("completed");
    expect(f.governanceMocks.publishArtifact).toHaveBeenCalledOnce();
  });

  it("reuses the reserved native identity after an interrupted first upload", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const operationId = randomUUID();
    f.governanceMocks.publishArtifact.mockImplementationOnce(async () => {
      throw new SkillHubGovernanceError("Synthetic failed first upload");
    });
    const request = { operationId, skill: "demo-skill", version: "1.2.3" };
    await expect(f.service.publish(f.actor, request)).rejects.toMatchObject({ statusCode: 502 });
    const reservedId = (await f.store.skillHubCatalog.get(operationId))!.registryId;
    expect(reservedId).toBeGreaterThan(0);
    f.governanceMocks.createNamespace.mockClear();
    await expect(f.service.publish(f.actor, request)).resolves.toMatchObject({ id: operationId });
    expect(f.governanceMocks.publishArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedSkillId: reservedId }),
    );
    expect(f.governanceMocks.createNamespace).not.toHaveBeenCalled();
    expect((await f.store.skillHubCatalog.get(operationId))?.registryId).toBe(reservedId);
  });
  it("creates independent same-name skills without adopting an existing owner's identity", async () => {
    const f = await fixture();
    const original = f.entry!;
    const result = await f.service.publish(f.actor, {
      operationId: randomUUID(),
      skill: "demo-skill",
      source: "platform_server",
      version: "1.2.3",
    });
    expect(result.id).not.toBe(original.id);
    const created = await f.store.skillHubCatalog.get(result.id);
    expect(created).toMatchObject({
      ownerUserId: f.actor.user.id,
      sharing: { mode: "PUBLIC" },
      slug: original.slug,
    });
    expect(created!.namespace).not.toBe(original.namespace);
    expect(await f.store.skillHubCatalog.get(original.id)).toEqual(original);
    expect(f.governanceMocks.publishArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: created!.namespace, filename: "demo-skill-1.2.3.zip" }),
    );
  });

  it("does not recreate a missing immutable native artifact during a pending retry", async () => {
    const f = await fixture();
    const original = f.entry!;
    const request = {
      operationId: randomUUID(),
      id: original.id,
      expectedRevision: original.revision,
      skill: original.slug,
      source: "platform_server" as const,
      version: "1.2.3",
    };
    f.governanceMocks.publishArtifact.mockRejectedValueOnce(
      new SkillHubAdapterError("Synthetic unavailable", 503),
    );
    await expect(f.service.publish(f.actor, request)).rejects.toMatchObject({ statusCode: 502 });
    f.native.delete(`${original.namespace}/${original.slug}`);
    f.governanceMocks.publishArtifact.mockClear();
    await expect(f.service.publish(f.actor, request)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
  });

  it.each(["PUBLIC", "NAMESPACE_ONLY", "PRIVATE"] as const)(
    "adds a version to the same %s native artifact without changing its catalog sharing or metadata",
    async (visibility) => {
      const f = await fixture();
      const original = f.entry!;
      const key = `${original.namespace}/${original.slug}`;
      const native = { ...f.native.get(key)!, visibility };
      f.native.set(key, native);
      const result = await f.service.publish(f.actor, {
        operationId: randomUUID(),
        id: original.id,
        expectedRevision: original.revision,
        skill: original.slug,
        version: "1.2.3",
      });
      expect(result).toEqual({ id: original.id, slug: original.slug, version: "1.2.3" });
      expect(f.governanceMocks.publishArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: original.namespace,
          expectedSkillId: original.registryId,
        }),
      );
      expect(f.governanceMocks.publishArtifact.mock.calls[0]?.[0]).not.toHaveProperty("visibility");
      expect(f.native.get(key)).toEqual(native);
      expect(await f.store.skillHubCatalog.get(original.id)).toMatchObject({
        sharing: original.sharing,
        ownerUserId: original.ownerUserId,
        registryId: original.registryId,
        currentVersion: "1.2.3",
      });
    },
  );

  it("recovers a committed native version after a lost reply without uploading it again", async () => {
    const f = await fixture();
    const original = f.entry!;
    const publish = f.governanceMocks.publishArtifact.getMockImplementation()!;
    f.governanceMocks.publishArtifact.mockImplementationOnce(async (params) => {
      await publish(params);
      throw new SkillHubGovernanceError("Synthetic lost publication reply");
    });
    const request = {
      operationId: randomUUID(),
      id: original.id,
      expectedRevision: original.revision,
      skill: original.slug,
      version: "1.2.3",
    };
    await expect(f.service.publish(f.actor, request)).rejects.toMatchObject({ statusCode: 502 });
    await expect(f.service.publish(f.actor, request)).resolves.toEqual({
      id: original.id,
      slug: original.slug,
      version: "1.2.3",
    });
    expect(f.governanceMocks.publishArtifact).toHaveBeenCalledOnce();
    const history = await f.store.skillHubCatalog.listHistory({
      skillId: original.id,
      actorUserId: f.actor.user.id,
    });
    expect(
      history.filter((item) => item.action === "version-published" && item.version === "1.2.3"),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    "never completes a publication when the returned immutable ID differs (existing=%s)",
    async (existing) => {
      const f = await fixture([], undefined, { registrySkill: existing ? "existing" : "absent" });
      const publish = f.governanceMocks.publishArtifact.getMockImplementation()!;
      f.governanceMocks.publishArtifact.mockImplementation(async (params) => ({
        ...(await publish(params)),
        skillId: 999,
      }));
      await expect(
        f.service.publish(f.actor, {
          operationId: randomUUID(),
          ...(f.entry ? { id: f.entry.id, expectedRevision: f.entry.revision } : {}),
          skill: "demo-skill",
          version: "1.2.3",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
      expect((await f.store.skillHubCatalog.list())[0]?.currentVersion).toBe(
        existing ? f.entry!.currentVersion : null,
      );
      expect(await f.store.skillHubCatalog.listPendingPublications()).toHaveLength(1);
    },
  );

  it("keeps a changed stored native identity as a conflict before any publication effect", async () => {
    const f = await fixture();
    const original = f.entry!;
    const key = `${original.namespace}/${original.slug}`;
    f.native.set(key, { ...f.native.get(key)!, id: 999 });
    await expect(
      f.service.publish(f.actor, {
        operationId: randomUUID(),
        id: original.id,
        expectedRevision: original.revision,
        skill: original.slug,
        version: "1.2.3",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
    expect(await f.store.skillHubCatalog.listPendingPublications()).toHaveLength(0);
    expect(await f.store.skillHubCatalog.get(original.id)).toEqual(original);
  });

  it("rechecks the active workspace when administrative login finishes before native publication", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const publish = f.governanceMocks.publishArtifact.getMockImplementation()!;
    f.governanceMocks.publishArtifact.mockImplementation(async (params) => {
      const binding = await f.store.getPersonalAgentBinding(f.actor.user.id);
      if (!binding) {
        throw new Error("Fixture Agent is missing");
      }
      await f.store.transitionAgent({ bindingId: binding.id, state: "disabled", changedAt: 50 });
      return await publish(params);
    });
    await expect(
      f.service.publish(f.actor, {
        operationId: randomUUID(),
        skill: "demo-skill",
        version: "1.2.3",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // The safe empty identity was committed before upload. Revocation still
    // prevents archive bytes, and cancellation can later clean up this identity.
    expect(f.native.size).toBe(1);
    expect(f.nativeVersions.size).toBe(0);
    expect(await f.store.skillHubCatalog.listPendingPublications()).toHaveLength(1);
  });

  it.each(["platform_server", "assigned_vm", "upload"] as const)(
    "rejects another owner's ID through %s",
    async (source) => {
      const f = await fixture();
      const other = await f.createActor("person.two");
      const foreign = await f.seedEntry({ ownerUserId: other.user.id });
      const fields = {
        operationId: randomUUID(),
        id: foreign.id,
        expectedRevision: foreign.revision,
        version: "1.2.3",
      };
      let publication: Promise<unknown>;
      if (source === "upload") {
        const zip = new JSZip();
        zip.file(
          "SKILL.md",
          "---\nname: demo-skill\ndescription: Demo\nversion: 1.2.3\n---\nInstructions",
        );
        const archive = await zip.generateAsync({ type: "nodebuffer" });
        const archivePath = path.join(f.workspaceRoot, "upload.zip");
        await writeFile(archivePath, archive);
        publication = f.service.publishArchive(
          f.actor,
          { ...fields, slug: "demo-skill" },
          { path: archivePath, size: archive.byteLength },
        );
      } else if (source === "assigned_vm") {
        // Authorization must precede any remote workspace export, even with a valid VM.
        publication = f.service.publish(f.actor, { ...fields, skill: "demo-skill", source });
      } else {
        publication = f.service.publish(f.actor, { ...fields, skill: "demo-skill", source });
      }
      await expect(publication).rejects.toMatchObject({ statusCode: 403 });
      expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
      expect(await f.store.skillHubCatalog.get(foreign.id)).toEqual(foreign);
    },
  );

  it.each([400, 403, 503])(
    "does not treat registry failure %s as an absent artifact",
    async (statusCode) => {
      const f = await fixture([], undefined, { registrySkill: "absent" });
      f.governanceMocks.reserveArtifactIdentity.mockRejectedValue(
        new SkillHubGovernanceError("request rejected", statusCode),
      );
      await expect(
        f.service.publish(f.actor, {
          operationId: randomUUID(),
          skill: "demo-skill",
          version: "1.2.3",
        }),
      ).rejects.toMatchObject({ statusCode: statusCode === 403 ? 403 : 502 });
      expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
    },
  );
  it("rejects duplicate immutable versions and sharing changes in an existing-version request before native writes", async () => {
    const f = await fixture();
    for (const params of [
      {
        operationId: randomUUID(),
        id: f.entry!.id,
        expectedRevision: f.entry!.revision,
        skill: "demo-skill",
        version: "1.0.0",
      },
      {
        operationId: randomUUID(),
        id: f.entry!.id,
        expectedRevision: f.entry!.revision,
        skill: "demo-skill",
        version: "1.2.3",
        sharing: { mode: "PRIVATE" as const, userIds: [], scopeIds: [] },
      },
    ]) {
      await expect(f.service.publish(f.actor, params)).rejects.toMatchObject({
        statusCode: params.sharing ? 400 : 409,
      });
    }
    expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
    expect(await f.store.skillHubCatalog.listPendingPublications()).toHaveLength(0);
    expect(await f.store.skillHubCatalog.get(f.entry!.id)).toEqual(f.entry);
  });
});
