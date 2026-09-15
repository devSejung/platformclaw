import { describe, expect, it, vi } from "vitest";
import { SkillHubAdapterError } from "./skill-hub-adapter.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SkillHubService registry deletion", () => {
  it("deletes only the registry copy for its owner and cleans PlatformClaw management state", async () => {
    const { service, actor, adapterMocks, store, adminRpcCall } = await fixture();
    await service.publish(actor, {
      skill: "demo-skill",
      namespace: "engineering",
      version: "1.2.3",
      visibility: "PRIVATE",
    });
    const ownership = await store.getSkillHubOwnership("engineering", "demo-skill");
    const removeState = vi.spyOn(store, "removeSkillHubSkillState");
    adminRpcCall.mockClear();

    await expect(
      service.deletePublishedSkill(actor.user, "engineering", "demo-skill", ownership!.updatedAt),
    ).resolves.toEqual({
      ok: true,
      deleted: true,
      namespace: "engineering",
      slug: "demo-skill",
    });
    expect(adapterMocks.deleteSkill).toHaveBeenCalledWith("engineering", "demo-skill");
    expect(removeState).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "engineering",
        slug: "demo-skill",
        actorUserId: actor.user.id,
      }),
    );
    expect(adminRpcCall).not.toHaveBeenCalled();
  });

  it("rejects stale registry deletion before calling the upstream hard-delete", async () => {
    const { service, actor, adapterMocks, store } = await fixture();
    await service.publish(actor, {
      skill: "demo-skill",
      namespace: "engineering",
      version: "1.2.3",
      visibility: "PRIVATE",
    });

    await expect(
      service.deletePublishedSkill(actor.user, "engineering", "demo-skill", 99),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(adapterMocks.deleteSkill).not.toHaveBeenCalled();
    await expect(store.getSkillHubOwnership("engineering", "demo-skill")).resolves.not.toBeNull();
  });

  it("does not let an administrator delete an upstream coordinate without PlatformClaw ownership", async () => {
    const { service, actor, adapterMocks } = await fixture();
    const admin = { ...actor.user, globalRole: "admin" as const };

    await expect(
      service.deletePublishedSkill(admin, "engineering", "demo-skill", 1),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(adapterMocks.deleteSkill).not.toHaveBeenCalled();
  });

  it("recovers local management state when a prior remote delete already removed the registry copy", async () => {
    const { service, actor, adapterMocks, store } = await fixture();
    await service.publish(actor, {
      skill: "demo-skill",
      namespace: "engineering",
      version: "1.2.3",
      visibility: "PRIVATE",
    });
    const ownership = await store.getSkillHubOwnership("engineering", "demo-skill");
    adapterMocks.deleteSkill.mockResolvedValue({
      ok: false,
      namespace: "engineering",
      slug: "demo-skill",
    });
    adapterMocks.getSkill.mockRejectedValueOnce(new SkillHubAdapterError("not found", 404));

    await expect(
      service.deletePublishedSkill(actor.user, "engineering", "demo-skill", ownership!.updatedAt),
    ).resolves.toMatchObject({ deleted: true });
    await expect(store.getSkillHubOwnership("engineering", "demo-skill")).resolves.toBeNull();
  });

  it("retains local management state when remote delete is ambiguous and the skill still resolves", async () => {
    const { service, actor, adapterMocks, store } = await fixture();
    await service.publish(actor, {
      skill: "demo-skill",
      namespace: "engineering",
      version: "1.2.3",
      visibility: "PRIVATE",
    });
    const ownership = await store.getSkillHubOwnership("engineering", "demo-skill");
    adapterMocks.deleteSkill.mockResolvedValue({
      ok: false,
      namespace: "engineering",
      slug: "demo-skill",
    });

    await expect(
      service.deletePublishedSkill(actor.user, "engineering", "demo-skill", ownership!.updatedAt),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.getSkillHubOwnership("engineering", "demo-skill")).resolves.not.toBeNull();
  });

  it("retains local management state when the upstream delete fails", async () => {
    const { service, actor, adapterMocks, store } = await fixture();
    await service.publish(actor, {
      skill: "demo-skill",
      namespace: "engineering",
      version: "1.2.3",
      visibility: "PRIVATE",
    });
    const ownership = await store.getSkillHubOwnership("engineering", "demo-skill");
    adapterMocks.deleteSkill.mockRejectedValue(
      new SkillHubAdapterError("registry unavailable", 503),
    );

    await expect(
      service.deletePublishedSkill(actor.user, "engineering", "demo-skill", ownership!.updatedAt),
    ).rejects.toMatchObject({ statusCode: 502 });
    await expect(store.getSkillHubOwnership("engineering", "demo-skill")).resolves.not.toBeNull();
  });

  it("lets an in-flight force approval finish before a queued registry delete", async () => {
    const approvalStarted = deferred();
    const releaseApproval = deferred();
    const approvePendingReview = vi.fn(async () => {
      approvalStarted.resolve();
      await releaseApproval.promise;
      return { reviewId: 42, status: "APPROVED" };
    });
    const { service, actor, adapterMocks, store } = await fixture(["engineering"], {
      approvePendingReview,
    });
    await service.publish(actor, {
      skill: "demo-skill",
      namespace: "engineering",
      version: "1.2.3",
      visibility: "PRIVATE",
    });
    const ownership = await store.getSkillHubOwnership("engineering", "demo-skill");

    const force = service.acknowledgeForcePublish(actor.user, "engineering", "demo-skill", {
      version: "1.2.3",
      acknowledged: true,
      reason: "reviewed scanner exception",
    });
    await approvalStarted.promise;
    const deletion = service.deletePublishedSkill(
      actor.user,
      "engineering",
      "demo-skill",
      ownership!.updatedAt,
    );
    await Promise.resolve();
    expect(adapterMocks.deleteSkill).not.toHaveBeenCalled();

    releaseApproval.resolve();
    await expect(force).resolves.toMatchObject({ upstreamOverridePerformed: true });
    await expect(deletion).resolves.toMatchObject({ deleted: true });
  });

  it("blocks force approval behind deletion and fails closed after the ownership root is removed", async () => {
    const deleteStarted = deferred();
    const releaseDelete = deferred();
    const approvePendingReview = vi.fn(async () => ({ reviewId: 42, status: "APPROVED" }));
    const { service, actor, adapterMocks, store } = await fixture(["engineering"], {
      approvePendingReview,
    });
    await service.publish(actor, {
      skill: "demo-skill",
      namespace: "engineering",
      version: "1.2.3",
      visibility: "PRIVATE",
    });
    const ownership = await store.getSkillHubOwnership("engineering", "demo-skill");
    adapterMocks.deleteSkill.mockImplementationOnce(async (namespace: string, slug: string) => {
      deleteStarted.resolve();
      await releaseDelete.promise;
      return { ok: true, namespace, slug };
    });

    const deletion = service.deletePublishedSkill(
      actor.user,
      "engineering",
      "demo-skill",
      ownership!.updatedAt,
    );
    await deleteStarted.promise;
    const force = service.acknowledgeForcePublish(actor.user, "engineering", "demo-skill", {
      version: "1.2.3",
      acknowledged: true,
      reason: "reviewed scanner exception",
    });
    await Promise.resolve();
    expect(approvePendingReview).not.toHaveBeenCalled();

    releaseDelete.resolve();
    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await expect(force).rejects.toMatchObject({ statusCode: 404 });
    expect(approvePendingReview).not.toHaveBeenCalled();
  });

  it("does not auto-approve a clean scan if registry deletion completes while scan polling is in flight", async () => {
    const scanStarted = deferred();
    const releaseScan = deferred();
    const approvePendingReview = vi.fn(async () => ({ reviewId: 42, status: "APPROVED" }));
    const { service, actor, adapterMocks, store } = await fixture(["engineering"], {
      approvePendingReview,
    });
    await service.publish(actor, {
      skill: "demo-skill",
      namespace: "engineering",
      version: "1.2.3",
      visibility: "PRIVATE",
    });
    const ownership = await store.getSkillHubOwnership("engineering", "demo-skill");
    vi.spyOn(store, "listDueSkillHubGovernanceJobs").mockResolvedValue([
      {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.2.3",
        ownerUserId: actor.user.id,
        state: "pending",
        attempts: 0,
        nextAttemptAt: 1,
        updatedAt: 1,
      },
    ]);
    adapterMocks.listVersions.mockResolvedValue([
      { id: 20, version: "1.2.3", status: "PENDING_REVIEW", downloadAvailable: true },
    ]);
    adapterMocks.listSecurityAudits.mockImplementationOnce(async () => {
      scanStarted.resolve();
      await releaseScan.promise;
      return [{ scannerType: "skill-scanner", verdict: "CLEAN", isSafe: true }];
    });

    const processing = service.processGovernanceQueue();
    await scanStarted.promise;
    await expect(
      service.deletePublishedSkill(actor.user, "engineering", "demo-skill", ownership!.updatedAt),
    ).resolves.toMatchObject({ deleted: true });
    releaseScan.resolve();
    await expect(processing).resolves.toEqual({ processed: 1 });
    expect(approvePendingReview).not.toHaveBeenCalled();
  });
});
