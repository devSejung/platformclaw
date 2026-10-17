import { describe, expect, it, vi } from "vitest";
import type { SkillHubSecurityAudit } from "./skill-hub-adapter.js";
import { createSkillHubServiceFixture } from "./skill-hub-service.test-fixtures.js";
import type { SkillHubGovernanceJob } from "./skill-hub-state.js";

async function scanningFixture() {
  const approvePendingReview = vi.fn(async () => ({ reviewId: 42, status: "APPROVED" }));
  const fixture = await createSkillHubServiceFixture(["engineering"], { approvePendingReview });
  await fixture.service.publish(fixture.actor, {
    skill: "demo-skill",
    namespace: "engineering",
    version: "1.2.3",
    visibility: "PUBLIC",
  });
  let status = "SCANNING";
  let audits: SkillHubSecurityAudit[] = [
    { scannerType: "SKILL_SCANNER", verdict: "SUSPICIOUS", isSafe: false },
  ];
  let job: SkillHubGovernanceJob = {
    namespace: "engineering",
    slug: "demo-skill",
    version: "1.2.3",
    ownerUserId: fixture.actor.user.id,
    state: "pending",
    attempts: 0,
    nextAttemptAt: 1,
    updatedAt: 1,
  };
  vi.spyOn(fixture.store, "listDueSkillHubGovernanceJobs").mockImplementation(async () =>
    job.state === "pending" ? [{ ...job }] : [],
  );
  vi.spyOn(fixture.store, "updateSkillHubGovernanceJob").mockImplementation(async (update) => {
    job = { ...job, ...update };
  });
  fixture.adapterMocks.getVersionState.mockImplementation(async () => ({
    id: 20,
    version: "1.2.3",
    status,
  }));
  fixture.adapterMocks.listVersions.mockImplementation(async () => [
    { id: 20, version: "1.2.3", status, downloadAvailable: true },
  ]);
  fixture.adapterMocks.listSecurityAudits.mockImplementation(async () => audits);
  return {
    ...fixture,
    approvePendingReview,
    get job() {
      return job;
    },
    setStatus(value: string) {
      status = value;
    },
    completeAudit() {
      audits = [
        {
          scannerType: "SKILL_SCANNER",
          verdict: "SAFE",
          isSafe: true,
          scannedAt: "2026-10-16T00:00:00Z",
        },
      ];
    },
    failAudit() {
      audits = [
        {
          scannerType: "SKILL_SCANNER",
          verdict: "SUSPICIOUS",
          isSafe: false,
          failedAt: "2026-10-16T00:00:00Z",
        },
      ];
    },
  };
}

describe("Skill Hub recorded scan lifecycle", () => {
  it("waits for native placeholder audits and an active rescan before approving completed SAFE evidence", async () => {
    const f = await scanningFixture();
    try {
      await f.service.processGovernanceQueue();
      expect(f.job).toMatchObject({ state: "pending", lastError: "scan-pending" });
      expect(f.approvePendingReview).not.toHaveBeenCalled();
      await expect(
        f.service.detail(f.actor.user, "engineering", "demo-skill"),
      ).resolves.toMatchObject({ scanner: { status: "pending", badge: "Scan pending" } });

      f.setStatus("PENDING_REVIEW");
      await f.service.processGovernanceQueue();
      expect(f.job).toMatchObject({ state: "pending", lastError: "scan-pending" });
      expect(f.approvePendingReview).not.toHaveBeenCalled();

      f.completeAudit();
      f.setStatus("SCANNING");
      await f.service.processGovernanceQueue();
      expect(f.approvePendingReview).not.toHaveBeenCalled();
      await expect(
        f.service.detail(f.actor.user, "engineering", "demo-skill"),
      ).resolves.toMatchObject({ scanner: { status: "pending" } });

      f.setStatus("PENDING_REVIEW");
      await f.service.processGovernanceQueue();
      expect(f.approvePendingReview).toHaveBeenCalledTimes(1);
      expect(f.job).toMatchObject({ state: "approved" });
      await expect(
        f.service.detail(f.actor.user, "engineering", "demo-skill"),
      ).resolves.toMatchObject({ scanner: { status: "passed", badge: "Scan passed" } });
    } finally {
      f.service.close();
    }
  });

  it.each(["SCAN_FAILED", "PUBLISHED"])(
    "reports terminal scan failure while the release remains %s",
    async (status) => {
      const f = await scanningFixture();
      try {
        f.setStatus(status);
        if (status === "PUBLISHED") {
          f.failAudit();
        }
        await f.service.processGovernanceQueue();
        expect(f.job).toMatchObject({ state: "blocked", lastError: "scan-failed" });
        expect(f.approvePendingReview).not.toHaveBeenCalled();
        await expect(
          f.service.detail(f.actor.user, "engineering", "demo-skill"),
        ).resolves.toMatchObject({ scanner: { status: "failed", badge: "Scan failed" } });
      } finally {
        f.service.close();
      }
    },
  );

  it.each([
    {
      scannerType: "SKILL_SCANNER",
      verdict: "SUSPICIOUS",
      isSafe: false,
      failedAt: "2026-10-16T00:00:00Z",
    },
    {
      scannerType: "SKILL_SCANNER",
      verdict: "SUSPICIOUS",
      isSafe: false,
      scannedAt: "2026-10-16T00:00:00Z",
    },
  ])("rechecks a replaced $verdict round before recording its decision", async (oldAudit) => {
    const f = await scanningFixture();
    try {
      f.completeAudit();
      f.setStatus("PENDING_REVIEW");
      f.adapterMocks.listSecurityAudits.mockResolvedValueOnce([oldAudit]);
      await f.service.processGovernanceQueue();
      expect(f.adapterMocks.listSecurityAudits).toHaveBeenCalledTimes(2);
      expect(f.approvePendingReview).toHaveBeenCalledTimes(1);
      expect(f.job).toMatchObject({ state: "approved" });
    } finally {
      f.service.close();
    }
  });
});
