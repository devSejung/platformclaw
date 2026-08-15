import { t } from "../../i18n/index.ts";

export function skillHubVisibilityLabel(value: string | undefined): string {
  switch (value) {
    case "PUBLIC":
      return t("skillsPage.skillHub.public");
    case "NAMESPACE_ONLY":
      return t("skillsPage.skillHub.namespaceOnly");
    case "PRIVATE":
      return t("skillsPage.skillHub.private");
    default:
      return value ?? "";
  }
}

export function skillHubScopeKindLabel(value: "team" | "group" | "part"): string {
  switch (value) {
    case "team":
      return t("skillHubPage.scopeTeam");
    case "group":
      return t("skillHubPage.scopeGroup");
    case "part":
      return t("skillHubPage.scopePart");
  }
  return value;
}

export function skillHubSkillStatusLabel(value: string | undefined): string {
  switch (value) {
    case "ACTIVE":
      return t("skillHubPage.statusActive");
    case "HIDDEN":
      return t("skillHubPage.statusHidden");
    case "ARCHIVED":
      return t("skillHubPage.statusArchived");
    default:
      return value ?? "";
  }
}

export function skillHubScannerStatusLabel(
  value: "not_available" | "pending" | "passed" | "failed",
): string {
  switch (value) {
    case "not_available":
      return t("skillHubPage.scannerNotAvailable");
    case "pending":
      return t("skillHubPage.scannerPending");
    case "passed":
      return t("skillHubPage.scannerPassed");
    case "failed":
      return t("skillHubPage.scannerFailed");
  }
  return value;
}

export function skillHubVersionStatusLabel(value: string): string {
  const key =
    {
      DRAFT: "skillHubPage.versionDraft",
      SCANNING: "skillHubPage.versionScanning",
      SCAN_FAILED: "skillHubPage.versionScanFailed",
      UPLOADED: "skillHubPage.versionUploaded",
      PENDING_REVIEW: "skillHubPage.versionPendingReview",
      PUBLISHED: "skillHubPage.versionPublished",
      REJECTED: "skillHubPage.versionRejected",
      YANKED: "skillHubPage.versionYanked",
    }[value] ?? null;
  return key ? t(key) : value;
}
