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

export function selectSkillHubTab(tab: PluginsHubTab, navigate: (route: string) => void): void {
  const route = routeForPluginsHubTab(tab);
  if (route) {
    navigate(route);
  }
}
import { routeForPluginsHubTab, type PluginsHubTab } from "../plugins/plugins-hub.ts";
