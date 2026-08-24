import { html, nothing } from "lit";
import "../components/modal-dialog.ts";
import { platformClawT as t } from "./i18n.ts";

export type OrganizationJoinAction = {
  kind: "request" | "cancel" | "approve" | "reject";
  id: string;
  target: string;
};

function formText(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function renderOrganizationJoinDialog(props: {
  action: OrganizationJoinAction | null;
  busy: boolean;
  error: string;
  onCancel(): void;
  onSubmit(reason: string): void;
}) {
  const action = props.action;
  if (!action) {
    return nothing;
  }
  return html`<openclaw-modal-dialog
    .open=${true}
    label=${t(`platformClaw.organization.join.action.${action.kind}`)}
    description=${action.target}
    @modal-cancel=${(event: Event) => {
      if (props.busy) {
        event.preventDefault();
      } else {
        props.onCancel();
      }
    }}
  >
    <form
      class="organization-action-form"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const reason = formText(event.currentTarget as HTMLFormElement, "reason");
        if (reason) {
          props.onSubmit(reason);
        }
      }}
    >
      <p><strong>${action.target}</strong></p>
      <label>
        <span>${t("platformClaw.organization.action.reason")}</span>
        <textarea name="reason" maxlength="500" required></textarea>
      </label>
      ${props.error
        ? html`<p class="organization-action-error" role="alert" tabindex="-1">${props.error}</p>`
        : nothing}
      <div class="organization-request-actions">
        <button class="btn" type="button" ?disabled=${props.busy} @click=${() => props.onCancel()}>
          ${t("platformClaw.organization.action.cancel")}
        </button>
        <button class="btn primary" type="submit" ?disabled=${props.busy}>
          ${t("platformClaw.organization.action.confirm")}
        </button>
      </div>
    </form>
  </openclaw-modal-dialog>`;
}
