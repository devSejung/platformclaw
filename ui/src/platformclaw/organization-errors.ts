import { platformClawT as t } from "./i18n.ts";
import { PlatformClawOrganizationApiError } from "./organization-api.ts";

export function organizationErrorMessage(error: unknown, archiving: boolean): string {
  if (!(error instanceof PlatformClawOrganizationApiError)) {
    return t("platformClaw.organization.errors.unavailable");
  }
  if (error.status === 403) {
    return t("platformClaw.organization.errors.forbidden");
  }
  if (error.status === 404) {
    return t("platformClaw.organization.errors.notFound");
  }
  if (error.status === 409) {
    if (error.code === "organization_membership_changed") {
      return t("platformClaw.organization.errors.membershipChanged");
    }
    if (error.code === "managed_scope_name_conflict") {
      return t("platformClaw.organization.errors.nameConflict");
    }
    return t(
      error.code === "organization_membership_not_found"
        ? "platformClaw.organization.errors.noMembershipRemoved"
        : "platformClaw.organization.errors.conflict",
    );
  }
  if (error.status === 400) {
    return t(
      archiving
        ? "platformClaw.organization.errors.archiveBlocked"
        : "platformClaw.organization.errors.invalid",
    );
  }
  return t("platformClaw.organization.errors.unavailable");
}
