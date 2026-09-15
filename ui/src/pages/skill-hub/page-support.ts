import { html } from "lit";
import { t } from "../../i18n/index.ts";
import type { PlatformClawSkillHubSearchItem } from "../../platformclaw/skill-hub.ts";

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

export function renderSkillHubCard(
  item: PlatformClawSkillHubSearchItem,
  onOpen: (ref: SkillHubRef) => void,
) {
  return html`<button class="skill-hub-card" type="button" @click=${() => onOpen(item)}>
    <span class="skill-hub-card__namespace">${item.namespace}</span>
    <strong class="skill-hub-card__name">${item.slug}</strong>
    <span class="skill-hub-card__summary">${item.summary}</span>
    <span class="skill-hub-card__meta">
      <span>${skillHubVersionLabel(item.latestVersion)}</span>
      <span>${t("skillHubPage.viewDetails")}</span>
    </span>
  </button>`;
}
