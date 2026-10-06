import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type {
  SpaceMember,
  SpaceRole,
} from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { platformClawT } from "./i18n.ts";
import type { SpacePeopleSearch, SpacePerson } from "./space-people-search.ts";
const t = (key: string) => platformClawT(`platformClaw.spaces.${key}`);
type PendingSpaceMember = { userId: string; label: string; role: SpaceRole | null };
export function renderSpaceMembers(props: {
  owner: boolean;
  members: SpaceMember[];
  busy: boolean;
  search: SpacePeopleSearch;
  pending: PendingSpaceMember | null;
  onAccount: (value: string, immediate?: boolean) => void;
  onPending: (value: PendingSpaceMember | null) => void;
  onConfirm: () => void;
}) {
  const search = props.search;
  const choose = (person: SpacePerson) =>
    props.onPending({
      userId: person.userId,
      label: `${person.displayName} (${person.accountId})`,
      role: "editor",
    });
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
            if (!props.busy) {
              props.onAccount(search.query, true);
            }
          }}
        >
          <label
            >${t("account")}<input
              role="combobox"
              aria-autocomplete="list"
              aria-controls="pc-space-people"
              aria-expanded=${search.candidates.length > 0 ? "true" : "false"}
              aria-activedescendant=${search.activeIndex >= 0
                ? `pc-space-person-${search.activeIndex}`
                : nothing}
              maxlength="160"
              autocomplete="off"
              ?disabled=${props.busy}
              .value=${search.query}
              @compositionstart=${(event: CompositionEvent) =>
                search.compose((event.target as HTMLInputElement).value)}
              @compositionend=${(event: CompositionEvent) =>
                props.onAccount((event.target as HTMLInputElement).value)}
              @input=${(event: InputEvent) => {
                const value = (event.target as HTMLInputElement).value;
                if (event.isComposing) {
                  search.compose(value);
                } else {
                  props.onAccount(value);
                }
              }}
              @keydown=${(event: KeyboardEvent) => {
                if (event.isComposing || props.busy) {
                  return;
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  search.move(event.key === "ArrowDown" ? 1 : -1);
                  const options = (
                    event.currentTarget as HTMLInputElement
                  ).form?.querySelectorAll<HTMLElement>('[role="option"]');
                  options?.[search.activeIndex]?.scrollIntoView?.({ block: "nearest" });
                } else if (event.key === "Enter" && search.candidates[search.activeIndex]) {
                  event.preventDefault();
                  choose(search.candidates[search.activeIndex]!);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onAccount("");
                }
              }}
          /></label>
          <button class="btn" ?disabled=${props.busy || !search.query.trim()}>
            ${t("findPerson")}
          </button>
          <div
            id="pc-space-people"
            class="pc-space-people"
            role="listbox"
            aria-label=${t("findPerson")}
          >
            ${search.candidates.map(
              (person, index) => html`<button
                type="button"
                class="btn"
                role="option"
                id=${`pc-space-person-${index}`}
                aria-selected=${index === search.activeIndex ? "true" : "false"}
                ?disabled=${props.busy}
                @click=${() => choose(person)}
              >
                ${t("invite")} ${person.displayName} (${person.accountId})
              </button>`,
            )}
          </div>
          <p role="status">
            ${search.loading
              ? t("loading")
              : search.searched && !search.candidates.length
                ? t("noPerson")
                : ""}
          </p>
          ${search.error ? html`<p role="alert">${search.error}</p>` : nothing}
        </form>`
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
