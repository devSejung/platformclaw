import { html } from "lit";
import type { KnowledgeVaultMember } from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { platformClawT } from "./i18n.ts";

const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
export type VaultDraft = {
  documentId?: string;
  expectedRevision?: number;
  title: string;
  logicalPath: string;
  content: string;
};
type VaultFormOptions = {
  busy: boolean;
  onSubmit: (event: SubmitEvent) => void;
  onCancel: () => void;
};

export function renderVaultCreateForm(options: VaultFormOptions) {
  return html`<form class="vaults__form" @submit=${options.onSubmit}>
    <label
      >${t("name")}<input
        class="settings-input"
        name="name"
        required
        maxlength="160"
        autofocus
        placeholder=${t("namePlaceholder")}
    /></label>
    <label
      >${t("description")}<input class="settings-input" name="description" maxlength="2000"
    /></label>
    <p class="vaults__hint">${t("createHint")}</p>
    <div class="vaults__actions">
      <button class="btn primary" ?disabled=${options.busy}>${t("create")}</button
      ><button type="button" class="btn" ?disabled=${options.busy} @click=${options.onCancel}>
        ${t("cancel")}
      </button>
    </div>
  </form>`;
}

export function renderVaultEditorForm(options: VaultFormOptions & { draft: VaultDraft }) {
  return html`<form class="vaults__form" data-vault-editor @submit=${options.onSubmit}>
    <label
      >${t("documentTitle")}<input
        class="settings-input"
        name="title"
        required
        .value=${options.draft.title}
        autofocus
    /></label>
    <label
      >${t("path")}<input
        class="settings-input"
        name="path"
        required
        .value=${options.draft.logicalPath}
        placeholder="guides/training.md"
    /></label>
    <label
      >${t("body")}<textarea
        class="settings-input"
        name="content"
        rows="12"
        .value=${options.draft.content}
      ></textarea>
    </label>
    <div class="vaults__actions">
      <button class="btn primary" ?disabled=${options.busy}>${t("save")}</button
      ><button type="button" class="btn" ?disabled=${options.busy} @click=${options.onCancel}>
        ${t("cancel")}
      </button>
    </div>
  </form>`;
}

export function renderVaultMembersForm(options: {
  members: KnowledgeVaultMember[];
  busy: boolean;
  onSubmit: (event: SubmitEvent) => void;
  onRemove: (userId: string) => void;
}) {
  return html`<section class="vaults__form">
    <p class="vaults__hint">${t("exportHint")}</p>
    <div>
      ${options.members.map(
        (member) => html`<div class="vaults__member">
          <div>
            <strong>${member.displayName}</strong>
            <p class="vaults__hint">${member.accountId} · ${t(member.role)}</p>
            <p class="vaults__hint">
              ${member.canExport ? t("exportAllowed") : t("exportNotAllowed")}
            </p>
          </div>
          <button
            class="btn btn--sm"
            ?disabled=${options.busy}
            @click=${() => options.onRemove(member.userId)}
          >
            ${t("removeMember")}
          </button>
        </div>`,
      )}
    </div>
    <form class="vaults__form" @submit=${options.onSubmit}>
      <label
        >${t("account")}<input class="settings-input" name="accountId" required autocomplete="off"
      /></label>
      <label
        >${t("role")}<select class="settings-select" name="role">
          <option value="reader">${t("reader")}</option>
          <option value="editor">${t("editor")}</option>
          <option value="owner">${t("owner")}</option>
        </select></label
      >
      <label class="vaults__checkbox"
        ><input type="checkbox" name="canExport" />${t("allowExport")}</label
      >
      <button class="btn primary" ?disabled=${options.busy}>${t("setMember")}</button>
    </form>
  </section>`;
}
