import type { PlatformUser } from "./contracts.js";

export type EmployeeDirectoryUser = Pick<PlatformUser, "id" | "lastLoginAt">;

export type EmployeeDirectoryOrganizationSnapshot = {
  org: unknown;
  isTestAccount: boolean;
};

export type EmployeeDirectoryBackfillOutcome = {
  status: "pending" | "synced" | "skipped" | "failed";
  reason?: string;
};

export function projectEmployeeDirectoryStatus(
  outcome: EmployeeDirectoryBackfillOutcome | undefined,
  joinPromptEligible: boolean,
  ssoRefreshUrl?: string,
) {
  const refreshUrl =
    outcome?.status === "skipped" && outcome.reason === "requires-authenticated-org"
      ? ssoRefreshUrl
      : undefined;
  return {
    ...(outcome ? { directorySync: { ...outcome, ...(refreshUrl ? { refreshUrl } : {}) } } : {}),
    joinPromptEligible:
      joinPromptEligible &&
      !(
        outcome?.status === "pending" ||
        outcome?.status === "failed" ||
        outcome?.reason === "requires-authenticated-org"
      ),
  };
}
