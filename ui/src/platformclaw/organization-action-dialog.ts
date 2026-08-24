import { html, nothing, type TemplateResult } from "lit";
import "../components/modal-dialog.ts";
import { platformClawT as t } from "./i18n.ts";
import type { OrganizationMemberRole } from "./organization-api.ts";

export type OrganizationPendingAction =
  | { kind: "add"; scopeId: string; userId: string; target: string }
  | {
      kind: "remove";
      scopeId: string;
      userId: string;
      target: string;
      expectedRole: OrganizationMemberRole;
    }
  | {
      kind: "role";
      scopeId: string;
      userId: string;
      target: string;
      role: OrganizationMemberRole;
      expectedRole: OrganizationMemberRole;
    }
  | {
      kind: "rename";
      scopeId: string;
      scopeRevision: number;
      target: string;
      currentName: string;
    }
  | { kind: "archive"; scopeId: string; scopeRevision: number; target: string };

export function renderOrganizationActionDialog(options: {
  action: OrganizationPendingAction | null;
  busy: boolean;
  error: string;
  onCancel(): void;
  onSubmit(input: { reason: string; name?: string }): void;
}): TemplateResult | typeof nothing {
  const action = options.action;
  if (!action) {
    return nothing;
  }
  const title = t(`platformClaw.organization.action.${action.kind}`);
  return html`<openclaw-modal-dialog
    label=${title}
    description=${action.target}
    @modal-cancel=${(event: Event) => {
      if (options.busy) {
        event.preventDefault();
        return;
      }
      options.onCancel();
    }}
  >
    <form
      class="exec-approval-card"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget as HTMLFormElement);
        const reason = String(data.get("reason") ?? "").trim();
        const name = String(data.get("name") ?? "").trim();
        if (reason) {
          options.onSubmit({ reason, ...(name ? { name } : {}) });
        }
      }}
    >
      <div class="exec-approval-header">
        <div>
          <div class="exec-approval-title">${title}</div>
          <div class="exec-approval-sub">${action.target}</div>
        </div>
      </div>
      ${action.kind === "archive"
        ? html`<div class="callout danger" role="note">
            ${t("platformClaw.organization.action.archiveWarning")}
          </div>`
        : nothing}
      ${options.error
        ? html`<div class="callout danger organization-action-error" role="alert" tabindex="-1">
            ${options.error}
          </div>`
        : nothing}
      ${action.kind === "rename"
        ? html`<label class="field">
            <span>${t("platformClaw.organization.structure.name")}</span>
            <input name="name" maxlength="120" required .value=${action.currentName} />
          </label>`
        : nothing}
      <label class="field">
        <span>${t("platformClaw.organization.action.reason")}</span>
        <textarea name="reason" maxlength="500" required></textarea>
      </label>
      <div class="exec-approval-actions">
        <button
          class="btn ${action.kind === "archive" || action.kind === "remove"
            ? "danger"
            : "primary"}"
          type="submit"
          ?disabled=${options.busy}
        >
          ${t("platformClaw.organization.action.confirm")}
        </button>
        <button class="btn" type="button" ?disabled=${options.busy} @click=${options.onCancel}>
          ${t("platformClaw.organization.action.cancel")}
        </button>
      </div>
    </form>
  </openclaw-modal-dialog>`;
}
