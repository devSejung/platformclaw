import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type {
  SpaceMember,
  SpaceRole,
} from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { platformClawT } from "./i18n.ts";
const t = (key: string) => platformClawT(`platformClaw.spaces.${key}`);
export type PendingSpaceMember = { userId: string; label: string; role: SpaceRole | null };
export function renderSpaceMembers(props: {
  owner: boolean;
  members: SpaceMember[];
  busy: boolean;
  account: string;
  candidates: Array<Omit<SpaceMember, "role">>;
  pending: PendingSpaceMember | null;
  onAccount: (value: string) => void;
  onPending: (value: PendingSpaceMember | null) => void;
  onFind: () => void;
  onConfirm: () => void;
}) {
  return html`<section class="card">
    <h3>${t("members")}</h3>
    ${props.members.map(
      (member) =>
        html`<div>
          <span>${member.displayName} (${member.accountId}) · ${t(member.role)}</span>${props.owner
            ? html`<select
                  aria-label=${`${member.displayName} ${t("role")}`}
                  .value=${live(member.role)}
                  ?disabled=${props.busy}
                  @change=${(event: Event) =>
                    props.onPending({
                      userId: member.userId,
                      label: member.displayName,
                      role: (event.target as HTMLSelectElement).value as SpaceRole,
                    })}
                >
                  ${["viewer", "editor", "owner"].map(
                    (role) =>
                      html`<option value=${role} ?selected=${role === member.role}>
                        ${t(role)}
                      </option>`,
                  )}</select
                ><button
                  class="btn btn--sm"
                  ?disabled=${props.busy}
                  @click=${() =>
                    props.onPending({
                      userId: member.userId,
                      label: member.displayName,
                      role: null,
                    })}
                >
                  ${t("remove")}
                </button>`
            : nothing}
        </div>`,
    )}
    ${props.owner
      ? html`<form
            @submit=${(event: Event) => {
              event.preventDefault();
              props.onFind();
            }}
          >
            <label
              >${t("account")}<input
                .value=${props.account}
                @input=${(event: Event) =>
                  props.onAccount((event.target as HTMLInputElement).value)} /></label
            ><button class="btn" ?disabled=${props.busy}>${t("findPerson")}</button>
          </form>
          ${props.candidates.map(
            (person) =>
              html`<button
                class="btn"
                @click=${() =>
                  props.onPending({
                    userId: person.userId,
                    label: `${person.displayName} (${person.accountId})`,
                    role: "editor",
                  })}
              >
                ${t("invite")} ${person.displayName} (${person.accountId})
              </button>`,
          )}`
      : nothing}
    ${props.pending
      ? html`<div role="alertdialog" aria-label=${t("confirmMember")}>
          <p>${props.pending.label}: ${t(props.pending.role ?? "remove")}</p>
          <p>${props.pending.role ? t("inviteNotice") : t("removeNotice")}</p>
          <button class="btn primary" ?disabled=${props.busy} @click=${props.onConfirm}>
            ${t("confirm")}</button
          ><button class="btn" ?disabled=${props.busy} @click=${() => props.onPending(null)}>
            ${t("cancel")}
          </button>
        </div>`
      : nothing}
  </section>`;
}
