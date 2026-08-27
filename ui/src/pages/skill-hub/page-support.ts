export function readSkillHubInitialQuery(url: string): string {
  return new URL(url).searchParams.get("q")?.trim() ?? "";
}

export function skillHubVersionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export type SkillHubRef = { namespace: string; slug: string };
export type InstallTarget = "platform_server" | "assigned_vm";
export type PendingVersionChange = {
  target: InstallTarget;
  currentVersion: string;
  currentRevision: string;
  requestedVersion: string;
  direction: "upgrade" | "downgrade" | "reinstall";
};
