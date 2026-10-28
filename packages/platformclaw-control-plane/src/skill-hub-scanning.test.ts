import { describe, expect, it } from "vitest";
import type { SkillHubSecurityAudit } from "./skill-hub-adapter.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

const completed = "2026-10-28T00:00:00Z";
describe("Skill Hub per-version scan lifecycle", () => {
  it("keeps heuristic warnings downloadable without approving or overriding a registry review", async () => {
    const f = await fixture();
    f.adapterMocks.listSecurityAudits.mockResolvedValue([
      {
        scannerType: "SKILL_SCANNER",
        verdict: "BLOCKED",
        isSafe: false,
        scannedAt: completed,
        findingsCount: 1,
        findings: [{ ruleId: "OBFUSCATION_BINARY_FILE", analyzer: "static", category: "malware" }],
      },
    ]);
    const detail = await f.service.detailById(f.actor.user, f.entry!.id);
    expect(detail.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: "1.0.0",
          downloadAvailable: true,
          scanner: { status: "warning", badge: "Warnings", blocked: false },
        }),
      ]),
    );
  });

  it("keeps released files visibly unverified when scanner evidence is unavailable", async () => {
    const f = await fixture();
    f.adapterMocks.listSecurityAudits.mockResolvedValue([
      { scannerType: "SKILL_SCANNER", verdict: "SUSPICIOUS", isSafe: false, failedAt: completed },
    ]);
    const detail = await f.service.detailById(f.actor.user, f.entry!.id);
    expect(
      detail.versions.every(
        (version) => version.downloadAvailable && version.scanner.status === "unverified",
      ),
    ).toBe(true);
  });

  it("durably blocks only the confirmed version, not another version or a later scan outage", async () => {
    const f = await fixture();
    const confirmed: SkillHubSecurityAudit = {
      scannerType: "SKILL_SCANNER",
      verdict: "BLOCKED",
      isSafe: false,
      scannedAt: completed,
      findings: [
        {
          ruleId: "VIRUSTOTAL_MALICIOUS_FILE",
          analyzer: "virustotal",
          category: "malware",
          fileHash: "a".repeat(64),
        },
      ],
    };
    f.adapterMocks.listSecurityAudits.mockImplementation(async (_skillId, versionId) =>
      versionId === 20 ? [confirmed] : [],
    );
    const detail = await f.service.detailById(f.actor.user, f.entry!.id);
    expect(detail.versions.find((version) => version.version === "1.0.0")).toMatchObject({
      downloadAvailable: false,
      scanner: { status: "blocked" },
    });
    expect(detail.versions.find((version) => version.version === "2.0.0")).toMatchObject({
      downloadAvailable: true,
    });
    f.adapterMocks.listSecurityAudits.mockResolvedValue([
      { scannerType: "SKILL_SCANNER", verdict: "SUSPICIOUS", failedAt: completed },
    ]);
    await expect(f.service.download(f.actor.user, f.entry!.id, "1.0.0")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(f.adapterMocks.download).not.toHaveBeenCalled();
    await f.service.detailById(f.actor.user, f.entry!.id);
    expect(
      (await f.service.notifications(f.actor.user)).items.filter(
        (item) => item.kind === "malware-blocked",
      ),
    ).toHaveLength(1);
  });
  it("never serves or installs a replacement native identity at a known coordinate", async () => {
    const f = await fixture();
    const entry = f.entry!;
    const native = f.native.get(`${entry.namespace}/${entry.slug}`)!;
    f.native.set(`${entry.namespace}/${entry.slug}`, { ...native, id: native.id + 100 });
    await expect(f.service.detailById(f.actor.user, entry.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(f.service.download(f.actor.user, entry.id, "1.0.0")).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      f.service.install(f.actor, {
        id: entry.id,
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.adapterMocks.download).not.toHaveBeenCalled();
    expect(f.adminRpcCall).not.toHaveBeenCalled();
  });
});
