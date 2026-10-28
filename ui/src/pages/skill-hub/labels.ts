import { t } from "../../i18n/index.ts";
import type {
  PlatformClawSkillHubDetail,
  PlatformClawSkillHubSharingMode,
} from "../../platformclaw/skill-hub.ts";

export function skillHubVisibilityLabel(
  value: PlatformClawSkillHubSharingMode | undefined,
): string {
  switch (value) {
    case "PUBLIC":
      return t("skillHubPage.sharingPublic");
    case "SELECTED":
      return t("skillHubPage.sharingSelected");
    case "PRIVATE":
      return t("skillHubPage.sharingPrivate");
    default:
      return "";
  }
}

export function skillHubScannerStatusLabel(
  value: NonNullable<PlatformClawSkillHubDetail["scanner"]>["status"],
): string {
  switch (value) {
    case "not_available":
    case "unverified":
      return t("skillHubPage.scannerUnverified");
    case "pending":
      return t("skillHubPage.scannerPending");
    case "passed":
      return t("skillHubPage.scannerPassed");
    case "warning":
      return t("skillHubPage.scannerWarning");
    case "failed":
    case "blocked":
      return t("skillHubPage.scannerBlocked");
    default:
      return t("skillHubPage.scannerUnverified");
  }
}

export function skillHubVersionStatusLabel(value: string): string {
  const key = {
    DRAFT: "skillHubPage.versionDraft",
    SCANNING: "skillHubPage.versionScanning",
    SCAN_FAILED: "skillHubPage.scannerUnverified",
    UPLOADED: "skillHubPage.versionUploaded",
    PENDING_REVIEW: "skillHubPage.versionPendingReview",
    PUBLISHED: "skillHubPage.versionPublished",
    REJECTED: "skillHubPage.versionRejected",
    YANKED: "skillHubPage.versionYanked",
  }[value];
  return key ? t(key) : value;
}
