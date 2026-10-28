import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import "../../components/modal-dialog.ts";
import "../../styles/skill-hub.css";
import { t } from "../../i18n/index.ts";
import { platformClawT } from "../../platformclaw/i18n.ts";
import type {
  PlatformClawSkillHubConfig,
  PlatformClawSkillHubNotification,
  PlatformClawSkillHubSharingDetail,
  PlatformClawSkillHubWorkspaceSkill,
  PlatformClawSkillHubWorkspaceTarget,
} from "../../platformclaw/skill-hub.ts";
import { renderSkillHubSharing, skillHubSharingInvalid } from "./sharing.ts";

type PublicationRecovery = {
  operationId: string;
  label: string;
  onRestore: () => void;
};

function renderPublicationRecovery(items: PublicationRecovery[] | undefined, busy: boolean) {
  if (!items?.length) {
    return nothing;
  }
  return html`<section class="callout skill-hub-publication-recovery">
    <strong>${t("skillHubPage.earlierPublicationRequests")}</strong>
    <p>${t("skillHubPage.publicationRecoveryHelp")}</p>
    ${items.map(
      (item, index) => html`<div>
        <span>
          ${t("skillHubPage.publicationRequestNumber", { number: String(index + 1) })} ·
          ${item.label}
        </span>
        <button
          class="btn btn--sm"
          data-operation-id=${item.operationId}
          aria-label=${`${t("skillHubPage.restorePublicationRequest")}: ${t("skillHubPage.publicationRequestNumber", { number: String(index + 1) })} · ${item.label}`}
          ?disabled=${busy}
          @click=${item.onRestore}
        >
          ${t("skillHubPage.restorePublicationRequest")}
        </button>
      </div>`,
    )}
  </section>`;
}

export function renderSkillHubNotifications(props: {
  open: boolean;
  loading: boolean;
  error?: string | null;
  items: PlatformClawSkillHubNotification[];
  onClose: () => void;
  onMarkAllRead: () => void;
}) {
  if (!props.open) {
    return nothing;
  }
  return html`<openclaw-modal-dialog
    label=${t("skillHubPage.notifications")}
    @modal-cancel=${props.onClose}
  >
    <section class="skill-hub-dialog">
      <header class="skill-hub-dialog__header">
        <h2>${t("skillHubPage.notifications")}</h2>
        <div>
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onMarkAllRead}>
            ${t("skillHubPage.markAllRead")}
          </button>
          <button class="btn btn--sm" @click=${props.onClose}>${t("skillsPage.close")}</button>
        </div>
      </header>
      ${props.error ? html`<div class="callout danger" role="alert">${props.error}</div>` : nothing}
      ${props.loading
        ? html`<p role="status">${t("common.loading")}</p>`
        : !props.items.length
          ? html`<p>${t("skillHubPage.noNotifications")}</p>`
          : html` <div class="skill-hub-notification-list">
              ${props.items.map(
                (item) => html`<article
                  class="skill-hub-notification ${item.readAt === null ? "is-unread" : ""}"
                >
                  <span class="skill-hub-notification__dot" aria-hidden="true"></span>
                  <div>
                    <p>
                      ${item.kind === "malware-blocked"
                        ? t("skillHubPage.malwareBlockedNotification")
                        : item.message}
                    </p>
                    <small>${new Date(item.createdAt).toLocaleString()}</small>
                  </div>
                </article>`,
              )}
            </div>`}
    </section>
  </openclaw-modal-dialog>`;
}

export function renderSkillHubWorkspacePublish(props: {
  open: boolean;
  config: PlatformClawSkillHubConfig | null;
  source: PlatformClawSkillHubWorkspaceTarget;
  targetLabel?: string;
  skills: PlatformClawSkillHubWorkspaceSkill[];
  skill: string;
  existingId: string;
  existingName?: string;
  version: string;
  sharing: PlatformClawSkillHubSharingDetail;
  loading: boolean;
  busy: boolean;
  error: string | null;
  recovery?: PublicationRecovery[];
  onClose: () => void;
  onSource: (source: PlatformClawSkillHubWorkspaceTarget) => void;
  onReload: () => void;
  onSkill: (skill: string) => void;
  onExisting: (id: string) => void;
  onVersion: (version: string) => void;
  onSharing: (sharing: PlatformClawSkillHubSharingDetail) => void;
  onPublish: () => void;
}) {
  if (!props.open) {
    return nothing;
  }
  const vmAvailable = props.config?.installTargets?.some(
    (target) => target.target === "assigned_vm" && target.available,
  );
  return html`<openclaw-modal-dialog
    label=${platformClawT("platformClaw.skillHub.publish.title")}
    @modal-cancel=${(event: Event) => (props.busy ? event.preventDefault() : props.onClose())}
  >
    <section class="skill-hub-dialog skill-hub-workspace-publish">
      <header class="skill-hub-dialog__header">
        <div>
          <h2>${platformClawT("platformClaw.skillHub.publish.title")}</h2>
          <p>${t("skillHubPage.publishHelp")}</p>
        </div>
        <button class="btn btn--sm" ?disabled=${props.busy} @click=${props.onClose}>
          ${t("skillsPage.close")}
        </button>
      </header>
      ${renderPublicationRecovery(props.recovery, props.busy)}
      <div class="skill-hub-upload__fields">
        <div class="field">
          <label class="field"
            ><span>${platformClawT("platformClaw.skillHub.publish.source")}</span>
            <select
              name="source"
              .value=${props.source}
              ?disabled=${props.busy}
              @change=${(event: Event) =>
                props.onSource(
                  (event.target as HTMLSelectElement).value as PlatformClawSkillHubWorkspaceTarget,
                )}
            >
              <option value="platform_server">
                ${platformClawT("platformClaw.skillHub.publish.sourceBasic")}
              </option>
              <option value="assigned_vm" ?disabled=${!vmAvailable}>
                ${platformClawT("platformClaw.skillHub.publish.sourceVm")}
              </option>
            </select>
          </label>
          ${props.source === "assigned_vm" && props.targetLabel
            ? html`<small class="skill-hub-target-label">${props.targetLabel}</small>`
            : nothing}
          <button
            class="btn btn--sm"
            ?disabled=${props.busy || props.loading}
            @click=${props.onReload}
          >
            ${t("skillHubPage.reloadWorkspaceSkills")}
          </button>
        </div>
        <label class="field"
          ><span>${platformClawT("platformClaw.skillHub.publish.skill")}</span>
          <select
            name="skill"
            .value=${props.skill}
            ?disabled=${props.loading || props.busy || !props.skills.length}
            @change=${(event: Event) => props.onSkill((event.target as HTMLSelectElement).value)}
          >
            <option value="" ?selected=${!props.skill}>
              ${platformClawT("platformClaw.skillHub.publish.chooseSkill")}
            </option>
            ${repeat(
              props.skills,
              (skill) => `${props.source}:${skill.skillKey}`,
              (skill) =>
                html`<option value=${skill.skillKey} ?selected=${props.skill === skill.skillKey}>
                  ${skill.name ?? skill.skillKey}
                </option>`,
            )}
          </select>
        </label>
        <label class="field"
          ><span>${t("skillHubPage.publishAs")}</span>
          <select
            name="existingId"
            .value=${props.existingId}
            ?disabled=${props.busy || Boolean(props.existingName)}
            @change=${(event: Event) => props.onExisting((event.target as HTMLSelectElement).value)}
          >
            <option value="" ?selected=${!props.existingId}>${t("skillHubPage.newSkill")}</option>
            ${props.existingName
              ? html`<option value=${props.existingId} selected>${props.existingName}</option>`
              : props.config?.ownedSkills.map(
                  (skill) =>
                    html`<option value=${skill.id} ?selected=${props.existingId === skill.id}>
                      ${t("skillHubPage.newVersionOf", { skill: skill.displayName })}
                    </option>`,
                )}
          </select>
        </label>
        <label class="field"
          ><span>${t("skillsPage.skillHub.version")}</span>
          <input
            name="version"
            .value=${props.version}
            ?disabled=${props.busy}
            placeholder="1.0.0"
            @input=${(event: Event) => props.onVersion((event.target as HTMLInputElement).value)}
          />
        </label>
      </div>
      ${props.existingId
        ? html`<p>${t("skillHubPage.sharingPreserved")}</p>`
        : renderSkillHubSharing({
            draft: props.sharing,
            config: props.config,
            disabled: props.busy,
            onChange: props.onSharing,
          })}
      ${props.loading
        ? html`<p role="status">${platformClawT("platformClaw.skillHub.publish.loading")}</p>`
        : props.error
          ? html`<div class="callout danger" role="alert">${props.error}</div>`
          : !props.skills.length
            ? html`<p>${platformClawT("platformClaw.skillHub.publish.empty")}</p>`
            : nothing}
      <button
        class="btn primary"
        ?disabled=${props.loading ||
        props.busy ||
        !props.skill ||
        !props.version ||
        (!props.existingId && skillHubSharingInvalid(props.sharing))}
        @click=${props.onPublish}
      >
        ${props.busy ? t("skillsPage.skillHub.publishing") : t("skillsPage.skillHub.publish")}
      </button>
    </section>
  </openclaw-modal-dialog>`;
}

export function renderSkillHubUpload(props: {
  open: boolean;
  config: PlatformClawSkillHubConfig | null;
  file: File | null;
  error?: string | null;
  slug: string;
  version: string;
  sharing: PlatformClawSkillHubSharingDetail;
  existing: { id: string; displayName: string } | null;
  busy: boolean;
  recovery?: PublicationRecovery[];
  onClose: () => void;
  onFile: (file: File | null) => void;
  onSlug: (value: string) => void;
  onVersion: (value: string) => void;
  onSharing: (value: PlatformClawSkillHubSharingDetail) => void;
  onPublish: () => void;
}) {
  if (!props.open) {
    return nothing;
  }
  const invalidFile = Boolean(
    props.file && props.file.size > (props.config?.maxUploadBytes ?? 500 * 1024 * 1024),
  );
  return html`<openclaw-modal-dialog
    label=${t(props.existing ? "skillHubPage.publishVersion" : "skillHubPage.uploadZip")}
    @modal-cancel=${(event: Event) => (props.busy ? event.preventDefault() : props.onClose())}
  >
    <section class="skill-hub-dialog skill-hub-upload">
      <header class="skill-hub-dialog__header">
        <div>
          <h2>${t(props.existing ? "skillHubPage.publishVersion" : "skillHubPage.uploadZip")}</h2>
          <p>${props.existing?.displayName ?? t("skillHubPage.publishHelp")}</p>
        </div>
        <button class="btn btn--sm" ?disabled=${props.busy} @click=${props.onClose}>
          ${t("skillsPage.close")}
        </button>
      </header>
      ${renderPublicationRecovery(props.recovery, props.busy)}
      ${props.error ? html`<div class="callout danger" role="alert">${props.error}</div>` : nothing}
      <label class="skill-hub-upload__drop"
        ><strong>${props.file?.name ?? t("skillHubPage.chooseZip")}</strong
        ><span>${t("skillHubPage.uploadLimit")}</span>
        <input
          type="file"
          accept=".zip,application/zip"
          ?disabled=${props.busy}
          @change=${(event: Event) =>
            props.onFile((event.target as HTMLInputElement).files?.[0] ?? null)}
        />
      </label>
      ${invalidFile
        ? html`<div class="callout danger">${t("skillHubPage.fileTooLarge")}</div>`
        : nothing}
      <div class="skill-hub-upload__fields">
        <label class="field"
          ><span>${t("skillHubPage.slug")}</span
          ><input
            name="slug"
            .value=${props.slug}
            ?disabled=${props.busy || Boolean(props.existing)}
            @input=${(event: Event) => props.onSlug((event.target as HTMLInputElement).value)}
        /></label>
        <label class="field"
          ><span>${t("skillsPage.skillHub.version")}</span
          ><input
            name="version"
            .value=${props.version}
            ?disabled=${props.busy}
            placeholder="1.0.0"
            @input=${(event: Event) => props.onVersion((event.target as HTMLInputElement).value)}
        /></label>
      </div>
      ${props.existing
        ? html`<p>${t("skillHubPage.sharingPreserved")}</p>`
        : renderSkillHubSharing({
            draft: props.sharing,
            config: props.config,
            disabled: props.busy,
            onChange: props.onSharing,
          })}
      <button
        class="btn primary"
        ?disabled=${props.busy ||
        invalidFile ||
        !props.file ||
        !props.slug ||
        !props.version ||
        (!props.existing && skillHubSharingInvalid(props.sharing))}
        @click=${props.onPublish}
      >
        ${t(props.busy ? "skillsPage.skillHub.publishing" : "skillsPage.skillHub.publish")}
      </button>
    </section>
  </openclaw-modal-dialog>`;
}

export function renderSkillHubVersionChange(props: {
  open: boolean;
  currentVersion: string;
  requestedVersion: string;
  direction: "upgrade" | "downgrade" | "reinstall";
  targetLabel?: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!props.open) {
    return nothing;
  }
  return html`<openclaw-modal-dialog
    label=${t("skillHubPage.versionChangeTitle")}
    @modal-cancel=${(event: Event) => (props.busy ? event.preventDefault() : props.onClose())}
  >
    <section class="skill-hub-dialog skill-hub-version-change">
      <header class="skill-hub-dialog__header">
        <div>
          <h2>${t("skillHubPage.versionChangeTitle")}</h2>
          ${props.targetLabel ? html`<p>${props.targetLabel}</p>` : nothing}
          <p>
            ${props.direction === "reinstall"
              ? `${t("skillHubPage.confirmVersionChange")}: v${props.currentVersion}.`
              : t("skillHubPage.versionChangeHelp", {
                  direction: t(`skillHubPage.${props.direction}`),
                  current: props.currentVersion,
                  requested: props.requestedVersion,
                })}
          </p>
        </div>
      </header>
      <div class="skill-hub-install-actions">
        <button class="btn" ?disabled=${props.busy} @click=${props.onClose}>
          ${t("skillsPage.close")}
        </button>
        <button class="btn danger" ?disabled=${props.busy} @click=${props.onConfirm}>
          ${t(props.busy ? "skillsPage.skillHub.installing" : "skillHubPage.confirmVersionChange")}
        </button>
      </div>
    </section>
  </openclaw-modal-dialog>`;
}

export function renderSkillHubDelete(props: {
  open: boolean;
  skill: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!props.open) {
    return nothing;
  }
  return html`<openclaw-modal-dialog
    label=${t("skillHubPage.deleteSkillTitle", { skill: props.skill })}
    @modal-cancel=${(event: Event) => (props.busy ? event.preventDefault() : props.onClose())}
  >
    <section class="skill-hub-dialog">
      <header>
        <h2>${t("skillHubPage.deleteSkillTitle", { skill: props.skill })}</h2>
        <p>${t("skillHubPage.trashHelp")}</p>
      </header>
      ${props.error ? html`<div class="callout danger" role="alert">${props.error}</div>` : nothing}
      <div class="skill-hub-install-actions">
        <button class="btn" ?disabled=${props.busy} @click=${props.onClose}>
          ${t("common.cancel")}
        </button>
        <button class="btn danger" ?disabled=${props.busy} @click=${props.onConfirm}>
          ${t(props.busy ? "skillHubPage.deletingSkill" : "skillHubPage.moveToTrash")}
        </button>
      </div>
    </section>
  </openclaw-modal-dialog>`;
}
