import { html, nothing } from "lit";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { platformClawT } from "../../platformclaw/i18n.ts";
import type {
  PlatformClawSkillHubConfig,
  PlatformClawSkillHubNotification,
  PlatformClawSkillHubWorkspaceSkill,
  PlatformClawSkillHubWorkspaceTarget,
} from "../../platformclaw/skill-hub.ts";

export function renderSkillHubNotifications(props: {
  open: boolean;
  loading: boolean;
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
      ${props.loading
        ? html`<div class="skill-hub-state">${t("skillsPage.skillHub.loading")}</div>`
        : props.items.length === 0
          ? html`<div class="skill-hub-state">${t("skillHubPage.noNotifications")}</div>`
          : html`<div class="skill-hub-notification-list">
              ${props.items.map(
                (item) => html`<article
                  class="skill-hub-notification ${item.readAt === null ? "is-unread" : ""}"
                >
                  <span class="skill-hub-notification__dot" aria-hidden="true"></span>
                  <div>
                    <strong>${item.kind.replaceAll("-", " ")}</strong>
                    <p>${item.message}</p>
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
  skills: PlatformClawSkillHubWorkspaceSkill[];
  skill: string;
  namespace: string;
  version: string;
  visibility: string;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSource: (source: PlatformClawSkillHubWorkspaceTarget) => void;
  onSkill: (skill: string) => void;
  onNamespace: (namespace: string) => void;
  onVersion: (version: string) => void;
  onVisibility: (visibility: string) => void;
  onPublish: () => void;
}) {
  if (!props.open) {
    return nothing;
  }
  const vmAvailable =
    props.config?.installTargets?.find((target) => target.target === "assigned_vm")?.available ===
    true;
  return html`<openclaw-modal-dialog
    label=${platformClawT("platformClaw.skillHub.publish.title")}
    @modal-cancel=${props.onClose}
  >
    <section class="skill-hub-dialog skill-hub-workspace-publish">
      <header class="skill-hub-dialog__header">
        <div>
          <h2>${platformClawT("platformClaw.skillHub.publish.title")}</h2>
          <p>${platformClawT("platformClaw.skillHub.publish.description")}</p>
        </div>
        <button class="btn btn--sm" ?disabled=${props.busy} @click=${props.onClose}>
          ${t("skillsPage.close")}
        </button>
      </header>
      <div class="skill-hub-upload__fields">
        <label class="field">
          <span>${platformClawT("platformClaw.skillHub.publish.source")}</span>
          <select
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
        <label class="field">
          <span>${platformClawT("platformClaw.skillHub.publish.skill")}</span>
          <select
            .value=${props.skill}
            ?disabled=${props.loading || props.busy || props.skills.length === 0}
            @change=${(event: Event) => props.onSkill((event.target as HTMLSelectElement).value)}
          >
            <option value="" ?selected=${props.skill === ""}>
              ${platformClawT("platformClaw.skillHub.publish.chooseSkill")}
            </option>
            ${props.skills.map(
              (skill) => html`<option
                value=${skill.skillKey}
                ?selected=${props.skill === skill.skillKey}
              >
                ${skill.name && skill.name !== skill.skillKey
                  ? `${skill.name} (${skill.skillKey})`
                  : skill.skillKey}
              </option>`,
            )}
          </select>
        </label>
        <label class="field">
          <span>${t("skillsPage.skillHub.namespace")}</span>
          <select
            .value=${props.namespace}
            ?disabled=${props.busy}
            @change=${(event: Event) =>
              props.onNamespace((event.target as HTMLSelectElement).value)}
          >
            ${props.config?.namespaces.map(
              (namespace) => html`<option value=${namespace}>${namespace}</option>`,
            )}
          </select>
        </label>
        <label class="field">
          <span>${t("skillsPage.skillHub.version")}</span>
          <input
            .value=${props.version}
            ?disabled=${props.busy}
            placeholder="1.0.0"
            @input=${(event: Event) => props.onVersion((event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>${t("skillsPage.skillHub.visibility")}</span>
          <select
            .value=${props.visibility}
            ?disabled=${props.busy}
            @change=${(event: Event) =>
              props.onVisibility((event.target as HTMLSelectElement).value)}
          >
            <option value="PUBLIC">${t("skillsPage.skillHub.public")}</option>
            <option value="NAMESPACE_ONLY">${t("skillsPage.skillHub.namespaceOnly")}</option>
            <option value="PRIVATE">${t("skillsPage.skillHub.private")}</option>
          </select>
        </label>
      </div>
      ${props.loading
        ? html`<div class="skill-hub-state" role="status">
            ${platformClawT("platformClaw.skillHub.publish.loading")}
          </div>`
        : props.error
          ? html`<div class="callout danger" role="alert">${props.error}</div>`
          : props.skills.length === 0
            ? html`<div class="skill-hub-state">
                ${platformClawT("platformClaw.skillHub.publish.empty")}
              </div>`
            : nothing}
      <button
        class="btn primary"
        ?disabled=${props.loading ||
        props.busy ||
        props.error !== null ||
        !props.skill ||
        !props.namespace ||
        !props.version}
        @click=${props.onPublish}
      >
        ${props.busy
          ? t("skillsPage.skillHub.publishing")
          : platformClawT("platformClaw.skillHub.publish.submit")}
      </button>
    </section>
  </openclaw-modal-dialog>`;
}

export function renderSkillHubUpload(props: {
  open: boolean;
  config: PlatformClawSkillHubConfig | null;
  file: File | null;
  slug: string;
  namespace: string;
  version: string;
  visibility: string;
  busy: boolean;
  onClose: () => void;
  onFile: (file: File | null) => void;
  onSlug: (value: string) => void;
  onNamespace: (value: string) => void;
  onVersion: (value: string) => void;
  onVisibility: (value: string) => void;
  onPublish: () => void;
}) {
  if (!props.open) {
    return nothing;
  }
  const maxBytes = props.config?.maxUploadBytes ?? 500 * 1024 * 1024;
  const invalidFile = props.file ? props.file.size > maxBytes : false;
  return html`<openclaw-modal-dialog
    label=${t("skillHubPage.uploadZip")}
    @modal-cancel=${props.onClose}
  >
    <section class="skill-hub-dialog skill-hub-upload">
      <header class="skill-hub-dialog__header">
        <div>
          <h2>${t("skillHubPage.uploadZip")}</h2>
          <p>${t("skillHubPage.uploadDescription")}</p>
        </div>
        <button class="btn btn--sm" @click=${props.onClose}>${t("skillsPage.close")}</button>
      </header>
      <label class="skill-hub-upload__drop">
        <strong>${props.file?.name ?? t("skillHubPage.chooseZip")}</strong>
        <span>${t("skillHubPage.uploadLimit")}</span>
        <input
          type="file"
          accept=".zip,application/zip"
          @change=${(event: Event) =>
            props.onFile((event.target as HTMLInputElement).files?.[0] ?? null)}
        />
      </label>
      ${invalidFile
        ? html`<div class="callout danger">${t("skillHubPage.fileTooLarge")}</div>`
        : nothing}
      <div class="skill-hub-upload__fields">
        <label class="field">
          <span>${t("skillHubPage.slug")}</span>
          <input
            .value=${props.slug}
            @input=${(event: Event) => props.onSlug((event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>${t("skillsPage.skillHub.namespace")}</span>
          <select
            .value=${props.namespace}
            @change=${(event: Event) =>
              props.onNamespace((event.target as HTMLSelectElement).value)}
          >
            ${props.config?.namespaces.map(
              (namespace) => html`<option value=${namespace}>${namespace}</option>`,
            )}
          </select>
        </label>
        <label class="field">
          <span>${t("skillsPage.skillHub.version")}</span>
          <input
            .value=${props.version}
            placeholder="1.0.0"
            @input=${(event: Event) => props.onVersion((event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>${t("skillsPage.skillHub.visibility")}</span>
          <select
            .value=${props.visibility}
            @change=${(event: Event) =>
              props.onVisibility((event.target as HTMLSelectElement).value)}
          >
            <option value="PUBLIC">${t("skillsPage.skillHub.public")}</option>
            <option value="NAMESPACE_ONLY">${t("skillsPage.skillHub.namespaceOnly")}</option>
            <option value="PRIVATE">${t("skillsPage.skillHub.private")}</option>
          </select>
        </label>
      </div>
      <button
        class="btn primary"
        ?disabled=${props.busy ||
        invalidFile ||
        !props.file ||
        !props.slug ||
        !props.namespace ||
        !props.version}
        @click=${props.onPublish}
      >
        ${props.busy ? t("skillsPage.skillHub.publishing") : t("skillHubPage.publishZip")}
      </button>
    </section>
  </openclaw-modal-dialog>`;
}

export function renderSkillHubVersionChange(props: {
  open: boolean;
  currentVersion: string;
  requestedVersion: string;
  direction: "upgrade" | "downgrade" | "reinstall";
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!props.open) {
    return nothing;
  }
  return html`<openclaw-modal-dialog
    label=${t("skillHubPage.versionChangeTitle")}
    @modal-cancel=${props.onClose}
  >
    <section class="skill-hub-dialog skill-hub-version-change">
      <header class="skill-hub-dialog__header">
        <div>
          <h2>${t("skillHubPage.versionChangeTitle")}</h2>
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
          ${props.busy
            ? t("skillsPage.skillHub.installing")
            : t("skillHubPage.confirmVersionChange")}
        </button>
      </div>
    </section>
  </openclaw-modal-dialog>`;
}
