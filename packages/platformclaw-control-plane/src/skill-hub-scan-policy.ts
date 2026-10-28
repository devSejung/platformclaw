import type { SkillHubSecurityAudit } from "./skill-hub-adapter.js";

export function projectSkillHubScan(audits: readonly SkillHubSecurityAudit[]) {
  // Skill Scanner 1.0.2 maps heuristic severity to BLOCKED. Only its hash-lookup
  // antivirus finding establishes confirmed malware; category/severity alone cannot.
  const blocked = audits.some(
    (audit) =>
      Boolean(audit.scannedAt) &&
      audit.findings?.some(
        (finding) =>
          finding.ruleId === "VIRUSTOTAL_MALICIOUS_FILE" &&
          finding.analyzer === "virustotal" &&
          finding.category === "malware" &&
          /^[a-f0-9]{64}$/iu.test(finding.fileHash ?? ""),
      ),
  );
  if (blocked) {
    return { status: "blocked", badge: "Malware blocked", blocked: true } as const;
  }
  const latest = new Map<string, SkillHubSecurityAudit>();
  for (const audit of audits) {
    const prior = latest.get(audit.scannerType);
    if (!prior || (audit.id ?? 0) >= (prior.id ?? 0)) {
      latest.set(audit.scannerType, audit);
    }
  }
  const current = [...latest.values()];
  if (current.length === 0 || current.some((audit) => audit.failedAt || !audit.scannedAt)) {
    return { status: "unverified", badge: "Not verified", blocked: false } as const;
  }
  if (current.some((audit) => audit.isSafe !== true || (audit.findingsCount ?? 0) > 0)) {
    return { status: "warning", badge: "Warnings", blocked: false } as const;
  }
  return { status: "passed", badge: "Scan passed", blocked: false } as const;
}
