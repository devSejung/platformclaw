import { html, nothing, type TemplateResult } from "lit";
import type { KnowledgeVaultSnapshot } from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { platformClawT } from "./i18n.ts";
import { renderVaultDialog } from "./memory-vault-catalog.ts";

type SelectedVault = NonNullable<KnowledgeVaultSnapshot["selected"]>;
type Attachment = SelectedVault["attachments"][number];
const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
const RPC = "platformclaw.vault.";
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

type BinaryRequest = (path: string, init?: RequestInit) => Promise<Response>;

export async function renameVaultLifecycle(options: {
  client: GatewayBrowserClient;
  vaultId: string;
  name: string;
  isCurrent: () => boolean;
  refresh: () => Promise<void>;
  onRenamed: () => void;
}) {
  await options.client.request(`${RPC}rename`, { vaultId: options.vaultId, name: options.name });
  if (!options.isCurrent()) {
    return;
  }
  options.onRenamed();
  await options.refresh();
}

export async function deleteVaultLifecycle(options: {
  client: GatewayBrowserClient;
  vaultId: string;
  isCurrent: () => boolean;
  onDeleted: () => void;
  refreshCatalog: () => Promise<void>;
}) {
  await options.client.request(`${RPC}delete`, { vaultId: options.vaultId });
  if (!options.isCurrent()) {
    return;
  }
  options.onDeleted();
  await options.refreshCatalog();
}

export async function deleteAttachmentLifecycle(options: {
  binary: BinaryRequest;
  vaultId: string;
  attachment: Pick<Attachment, "path" | "revision">;
  isCurrent: () => boolean;
  refresh: () => Promise<void>;
  onDeleted: () => void;
}) {
  await options.binary(
    `/attachment?${new URLSearchParams({
      vaultId: options.vaultId,
      path: options.attachment.path,
      expectedRevision: String(options.attachment.revision),
    })}`,
    { method: "DELETE" },
  );
  if (!options.isCurrent()) {
    return;
  }
  options.onDeleted();
  await options.refresh();
}

export async function uploadAttachment(options: {
  binary: BinaryRequest;
  vaultId: string;
  file: File;
  isCurrent: () => boolean;
  refresh: () => Promise<void>;
}) {
  if (options.file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(t("tooLarge"));
  }
  await options.binary(
    `/attachment?${new URLSearchParams({ vaultId: options.vaultId, path: options.file.name })}`,
    {
      method: "PUT",
      headers: { "Content-Type": options.file.type || "application/octet-stream" },
      body: options.file,
    },
  );
  if (options.isCurrent()) {
    await options.refresh();
  }
}

export async function replaceAttachment(options: {
  binary: BinaryRequest;
  vaultId: string;
  attachment: Attachment;
  file: File;
  isCurrent: () => boolean;
  refresh: () => Promise<void>;
  onReplaced: () => void;
}) {
  if (options.file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(t("tooLarge"));
  }
  await options.binary(
    `/attachment?${new URLSearchParams({
      vaultId: options.vaultId,
      path: options.attachment.path,
      expectedRevision: String(options.attachment.revision),
    })}`,
    {
      method: "PUT",
      headers: { "Content-Type": options.file.type || "application/octet-stream" },
      body: options.file,
    },
  );
  if (!options.isCurrent()) {
    return;
  }
  await options.refresh();
  options.onReplaced();
}

export async function downloadAttachment(options: {
  binary: BinaryRequest;
  vaultId: string;
  attachment: Attachment;
  isCurrent: () => boolean;
  download: (blob: Blob, filename: string) => void;
}) {
  const response = await options.binary(
    `/attachment?${new URLSearchParams({
      vaultId: options.vaultId,
      path: options.attachment.path,
    })}`,
  );
  const blob = await response.blob();
  if (options.isCurrent()) {
    options.download(blob, options.attachment.path.split("/").at(-1)!);
  }
}

export function renderVaultRenameForm(options: {
  vault: SelectedVault["vault"];
  busy: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  return html`<form
    class="vaults__form"
    @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const value = data.get("name");
      options.onSubmit(typeof value === "string" ? value : "");
    }}
  >
    <p class="vaults__hint">${t("renameVaultHint")}</p>
    <label
      >${t("name")}<input
        class="settings-input"
        name="name"
        required
        maxlength="160"
        .value=${options.vault.name}
        autofocus
    /></label>
    <div class="vaults__actions">
      <button class="btn primary" ?disabled=${options.busy}>${t("saveVaultName")}</button>
      <button class="btn" type="button" ?disabled=${options.busy} @click=${options.onCancel}>
        ${t("cancel")}
      </button>
    </div>
  </form>`;
}

export function renderVaultDeleteConfirmation(options: {
  vault: SelectedVault["vault"];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return html`<section class="vaults__form">
    <p><strong>${options.vault.name}</strong></p>
    <p>${t("deleteVaultHint")}</p>
    <div class="vaults__actions">
      <button class="btn danger" ?disabled=${options.busy} @click=${options.onConfirm}>
        ${t("deleteVaultConfirm")}
      </button>
      <button class="btn" ?disabled=${options.busy} @click=${options.onCancel}>
        ${t("cancel")}
      </button>
    </div>
  </section>`;
}

export function renderAttachmentDeleteConfirmation(options: {
  path: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return html`<section class="vaults__form">
    <p><strong>${options.path}</strong></p>
    <p>${t("deleteAttachmentHint")}</p>
    <div class="vaults__actions">
      <button class="btn danger" ?disabled=${options.busy} @click=${options.onConfirm}>
        ${t("deleteAttachmentConfirm")}
      </button>
      <button class="btn" ?disabled=${options.busy} @click=${options.onCancel}>
        ${t("cancel")}
      </button>
    </div>
  </section>`;
}

export function renderVaultManagementActions(options: {
  selected: SelectedVault;
  methods: readonly string[];
  busy: boolean;
  authorOpen: boolean;
  onMembers: () => void;
  onExport: () => void;
  onRebuild: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { vault } = options.selected;
  const canRename =
    vault.type === "shared" &&
    vault.role === "owner" &&
    options.methods.includes("platformclaw.vault.rename");
  const canDelete =
    vault.type === "shared" &&
    vault.role === "owner" &&
    options.methods.includes("platformclaw.vault.delete");
  if (!vault.canManageMembers && !vault.canExport && !vault.canEdit && !canRename && !canDelete) {
    return nothing;
  }
  return html`<details class="vaults__management">
    <summary>${t("manageVault")}</summary>
    <div class="vaults__actions">
      ${vault.type === "shared" && vault.canManageMembers
        ? html`<button class="btn btn--sm" @click=${options.onMembers}>${t("members")}</button>`
        : nothing}
      ${vault.canExport
        ? html`<button
            class="btn btn--sm"
            ?disabled=${options.busy || options.authorOpen}
            @click=${options.onExport}
          >
            ${t("export")}
          </button>`
        : nothing}
      ${vault.canEdit
        ? html`<button
            class="btn btn--sm"
            ?disabled=${options.busy || options.authorOpen}
            @click=${options.onRebuild}
          >
            ${t("rebuild")}
          </button>`
        : nothing}
      ${canRename
        ? html`<button class="btn btn--sm" ?disabled=${options.busy} @click=${options.onRename}>
            ${t("renameVault")}
          </button>`
        : nothing}
      ${canDelete
        ? html`<button
            class="btn btn--sm danger"
            ?disabled=${options.busy}
            @click=${options.onDelete}
          >
            ${t("deleteVault")}
          </button>`
        : nothing}
    </div>
  </details>`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Number((bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0))} KB`;
  }
  return `${Number((bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0))} MB`;
}

export function renderVaultAttachments(options: {
  selected: SelectedVault;
  busy: boolean;
  renderFileInput: (
    label: string,
    accept: string,
    action: (file: File) => Promise<void>,
    small?: boolean,
  ) => TemplateResult;
  onUpload: (file: File) => Promise<void>;
  onDownload: (attachment: Attachment) => void;
  onReplace: (attachment: Attachment, file: File) => Promise<void>;
  onDelete: (attachment: Attachment) => void;
}) {
  const { selected } = options;
  return html`<details class="card">
    <summary>${t("attachments")}</summary>
    <p class="vaults__hint">${t("attachmentHint")}</p>
    ${selected.attachmentsTruncated
      ? html`<p class="callout" role="status">${t("attachmentsTruncated")}</p>`
      : nothing}
    ${selected.vault.canEdit
      ? options.renderFileInput("uploadAttachment", "", options.onUpload)
      : nothing}
    ${selected.attachments.map(
      (attachment) => html`<div class="vaults__member">
        <span>
          <strong>${attachment.path.split("/").at(-1)}</strong>
          <span class="muted"> · ${formatBytes(attachment.bytes)}</span>
        </span>
        <div class="vaults__actions">
          <button
            class="btn btn--sm"
            ?disabled=${options.busy}
            @click=${() => options.onDownload(attachment)}
          >
            ${t("downloadAttachment")}
          </button>
          ${selected.vault.canEdit
            ? html`${options.renderFileInput(
                  "replaceAttachment",
                  "",
                  (file) => options.onReplace(attachment, file),
                  true,
                )}
                <button
                  class="btn btn--sm danger"
                  ?disabled=${options.busy}
                  @click=${() => options.onDelete(attachment)}
                >
                  ${t("deleteAttachment")}
                </button>`
            : nothing}
        </div>
      </div>`,
    )}
  </details>`;
}

export function renderVaultSelectedLayout(options: {
  selected: SelectedVault;
  busy: boolean;
  authorOpen: boolean;
  canAuthor: boolean;
  management: unknown;
  search: unknown;
  attachments: unknown;
  onBack: () => void;
  onAddKnowledge: () => void;
  onDocumentOpen: (documentId: string) => void;
}) {
  const { vault } = options.selected;
  return html`<section class="vaults__selected">
    <button class="btn btn--sm vaults__back" ?disabled=${options.busy} @click=${options.onBack}>
      ${t("backToVaults")}
    </button>
    <header>
      <h2>${vault.name}</h2>
      <p>${vault.description}</p>
      <p class="muted">${t(vault.type)} · ${t(vault.role)}</p>
    </header>
    ${options.management}
    <div class="vaults__heading">
      <h3>${t("documents")}</h3>
      ${vault.canEdit && options.canAuthor
        ? html`<button
            class="btn primary"
            ?disabled=${options.busy}
            @click=${options.onAddKnowledge}
          >
            ${t("addKnowledge")}
          </button>`
        : nothing}
    </div>
    ${options.search}
    <platformclaw-vault-documents
      .selected=${options.selected}
      .busy=${options.busy || options.authorOpen}
      @vault-document-open=${(event: CustomEvent<string>) => options.onDocumentOpen(event.detail)}
    ></platformclaw-vault-documents>
    ${options.attachments}
  </section>`;
}

export function renderVaultStateDialog(options: {
  creating: boolean;
  membersOpen: boolean;
  importing: boolean;
  renaming: boolean;
  deletingVault: boolean;
  deletingAttachment: boolean;
  requestingAccess: boolean;
  busy: boolean;
  error: string;
  create: unknown;
  members: unknown;
  importVault: unknown;
  rename: unknown;
  deleteVault: unknown;
  deleteAttachment: unknown;
  requestAccess: unknown;
  onClose: () => void;
}) {
  const kind = options.creating
    ? "new"
    : options.membersOpen
      ? "members"
      : options.importing
        ? "import"
        : options.renaming
          ? "renameVault"
          : options.deletingVault
            ? "deleteVault"
            : options.deletingAttachment
              ? "deleteAttachmentTitle"
              : options.requestingAccess
                ? "requestAccess"
                : null;
  if (!kind) {
    return nothing;
  }
  const content = options.creating
    ? options.create
    : options.membersOpen
      ? options.members
      : options.importing
        ? options.importVault
        : options.renaming
          ? options.rename
          : options.deletingVault
            ? options.deleteVault
            : options.deletingAttachment
              ? options.deleteAttachment
              : options.requestAccess;
  return renderVaultDialog({
    title: t(kind),
    content,
    busy: options.busy,
    error: options.error,
    onClose: options.onClose,
  });
}
