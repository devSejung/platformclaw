import { describe, expect, it } from "vitest";
import { projectSkillHubScan } from "./skill-hub-scan-policy.js";

describe("Skill Hub publication scan policy", () => {
  it("publishes an unknown or failed scan as visibly unverified", () => {
    expect(projectSkillHubScan([])).toMatchObject({ status: "unverified", blocked: false });
    expect(
      projectSkillHubScan([
        { scannerType: "skill-scanner", verdict: "SUSPICIOUS", failedAt: "2026-10-28" },
      ]),
    ).toMatchObject({ status: "unverified", blocked: false });
  });

  it("treats severity and generic malware categories as warnings, not antivirus evidence", () => {
    expect(
      projectSkillHubScan([
        {
          scannerType: "skill-scanner",
          verdict: "BLOCKED",
          isSafe: false,
          maxSeverity: "CRITICAL",
          findingsCount: 1,
          scannedAt: "2026-10-28",
          findings: [
            { ruleId: "OBFUSCATION_BINARY_FILE", category: "malware", analyzer: "static" },
          ],
        },
      ]),
    ).toMatchObject({ status: "warning", blocked: false });
  });

  it("blocks a completed, hash-backed malicious-file finding from the antivirus analyzer", () => {
    const finding = {
      ruleId: "VIRUSTOTAL_MALICIOUS_FILE",
      analyzer: "virustotal",
      category: "malware",
      fileHash: "a".repeat(64),
    };
    expect(
      projectSkillHubScan([
        {
          scannerType: "skill-scanner",
          verdict: "BLOCKED",
          isSafe: false,
          scannedAt: "2026-10-28",
          findings: [finding],
        },
      ]),
    ).toMatchObject({ status: "blocked", blocked: true });
    expect(
      projectSkillHubScan([
        {
          scannerType: "skill-scanner",
          verdict: "BLOCKED",
          isSafe: false,
          scannedAt: "2026-10-28",
          findings: [{ ...finding, fileHash: undefined }],
        },
      ]),
    ).toMatchObject({ status: "warning", blocked: false });
  });

  it("shows a completed clean scan as passed", () => {
    expect(
      projectSkillHubScan([
        {
          scannerType: "skill-scanner",
          verdict: "SAFE",
          isSafe: true,
          scannedAt: "2026-10-28",
          findingsCount: 0,
        },
      ]),
    ).toMatchObject({ status: "passed", blocked: false });
  });
  it("shows the newest scanner round while preserving older confirmed-malware evidence", () => {
    const oldFailure = {
      id: 1,
      scannerType: "SKILL_SCANNER",
      verdict: "SUSPICIOUS",
      failedAt: "2026-10-27",
    };
    const newClean = {
      id: 2,
      scannerType: "SKILL_SCANNER",
      verdict: "SAFE",
      isSafe: true,
      scannedAt: "2026-10-28",
    };
    expect(projectSkillHubScan([oldFailure, newClean])).toMatchObject({
      status: "passed",
      blocked: false,
    });
    expect(
      projectSkillHubScan([
        {
          ...oldFailure,
          scannedAt: "2026-10-27",
          findings: [
            {
              ruleId: "VIRUSTOTAL_MALICIOUS_FILE",
              analyzer: "virustotal",
              category: "malware",
              fileHash: "a".repeat(64),
            },
          ],
        },
        newClean,
      ]),
    ).toMatchObject({ status: "blocked", blocked: true });
  });
});
