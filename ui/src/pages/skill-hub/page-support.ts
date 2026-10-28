import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { platformClawT } from "../../platformclaw/i18n.ts";
import type {
  PlatformClawSkillHubMessage,
  PlatformClawSkillHubSearchItem,
} from "../../platformclaw/skill-hub.ts";

export function readSkillHubInitialQuery(url: string): string {
  return new URL(url).searchParams.get("q")?.trim() ?? "";
}

export function skillHubVersionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export type SkillHubRef = { id: string; slug: string };
export type InstallTarget = "platform_server" | "assigned_vm";
export type PendingVersionChange = {
  target: InstallTarget;
  currentVersion: string;
  currentRevision: string;
  requestedVersion: string;
  direction: "upgrade" | "downgrade" | "reinstall";
};

export async function refreshSkillHubAfterMutation(
  text: string,
  refresh: () => Promise<void>,
  setMessage: (message: PlatformClawSkillHubMessage) => void,
): Promise<void> {
  // The mutation has committed. A failed read must not hide its outcome or offer a retry.
  setMessage({ kind: "success", text });
  try {
    await refresh();
  } catch (error) {
    setMessage({
      kind: "warning",
      text: platformClawT("platformClaw.skillHub.changedReloadFailed", {
        outcome: text,
        error: error instanceof Error ? error.message : String(error),
      }),
    });
  }
}

export function renderSkillHubCard(
  item: PlatformClawSkillHubSearchItem,
  onOpen: (ref: SkillHubRef) => void,
) {
  return html`<button class="skill-hub-card" type="button" @click=${() => onOpen(item)}>
    ${item.iconUrl
      ? html`<img class="skill-hub-icon" src=${item.iconUrl} alt="" loading="lazy" />`
      : html`<span class="skill-hub-icon skill-hub-icon--default" aria-hidden="true">◇</span>`}
    <strong class="skill-hub-card__name">${item.displayName}</strong>
    <span class="skill-hub-card__summary">${item.summary}</span>
    <span class="skill-hub-badges"
      >${item.tags.map((tag) => html`<span class="skill-hub-tag">${tag}</span>`)}</span
    >
    <span class="skill-hub-card__meta">
      <span
        >${item.owner.user?.displayName ??
        item.owner.user?.accountId ??
        t("skillHubPage.ownerUnassigned")}</span
      >
      ${item.latestVersion
        ? html`<span>${skillHubVersionLabel(item.latestVersion)}</span>`
        : nothing}
      <span>${t("skillHubPage.viewDetails")}</span>
    </span>
  </button>`;
}
