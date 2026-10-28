import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  searchPlatformClawSkillHubUsers,
  type PlatformClawSkillHubUser,
} from "../../platformclaw/skill-hub.ts";

/** A query generation prevents stale directory results from replacing a new selection. */
class SkillHubUserPicker extends OpenClawLightDomElement {
  @property() purpose: "owner" | "access" = "owner";
  @property({ type: Boolean }) disabled = false;
  @property({ attribute: false }) onSelect?: (user: PlatformClawSkillHubUser | null) => void;
  @state() private query = "";
  @state() private candidates: PlatformClawSkillHubUser[] = [];
  @state() private activeIndex = -1;
  @state() private loading = false;
  @state() private searched = false;
  @state() private error = "";
  private epoch = 0;
  private readonly controlId = crypto.randomUUID();
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("purpose")) {
      this.dismiss();
      this.query = "";
      this.onSelect?.(null);
    }
  }

  override disconnectedCallback() {
    this.dismiss();
    super.disconnectedCallback();
  }

  private dismiss() {
    this.epoch++;
    clearTimeout(this.timer);
    this.loading = false;
    this.searched = false;
    this.error = "";
    this.candidates = [];
    this.activeIndex = -1;
  }

  private updateQuery(query: string, composing = false) {
    this.dismiss();
    this.query = query;
    this.onSelect?.(null);
    if (composing || query.trim().length < 2) {
      return;
    }
    this.loading = true;
    const epoch = this.epoch;
    this.timer = setTimeout(() => void this.search(query.trim(), epoch), 250);
  }

  private async search(query: string, epoch: number) {
    try {
      const result = await searchPlatformClawSkillHubUsers(query);
      if (epoch === this.epoch) {
        this.candidates = result.users;
        this.searched = true;
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
      }
    }
  }

  private choose(user: PlatformClawSkillHubUser) {
    if (this.disabled) {
      return;
    }
    this.dismiss();
    this.query = `${user.displayName ?? user.accountId} (${user.accountId})`;
    this.onSelect?.(user);
  }

  private keydown(event: KeyboardEvent) {
    if (event.isComposing || this.disabled) {
      return;
    }
    const count = this.candidates.length;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      this.activeIndex =
        this.activeIndex < 0
          ? direction > 0
            ? 0
            : count - 1
          : (this.activeIndex + direction + count) % count;
      void this.updateComplete.then(() =>
        this.querySelectorAll<HTMLElement>('[role="option"]')[this.activeIndex]?.scrollIntoView?.({
          block: "nearest",
        }),
      );
    } else if (event.key === "Enter" && this.candidates[this.activeIndex]) {
      event.preventDefault();
      this.choose(this.candidates[this.activeIndex]!);
    } else if (event.key === "Escape" && count) {
      event.preventDefault();
      event.stopPropagation();
      this.dismiss();
    }
  }

  override render() {
    const id = `skill-hub-${this.purpose}-${this.controlId}`;
    const label = `${t(this.purpose === "owner" ? "skillHubPage.owner" : "skillHubPage.individualAccess")}: ${t("skillHubPage.searchUsers")}`;
    const open = this.candidates.length > 0;
    return html`<div
      class="skill-hub-user-picker"
      @focusout=${(event: FocusEvent) => {
        if (!this.contains(event.relatedTarget as Node | null)) {
          this.dismiss();
        }
      }}
    >
      <input
        class="settings-input"
        role="combobox"
        aria-label=${label}
        aria-autocomplete="list"
        aria-controls=${id}
        aria-describedby=${`${id}-help`}
        aria-expanded=${open ? "true" : "false"}
        aria-activedescendant=${open && this.activeIndex >= 0
          ? `${id}-${this.activeIndex}`
          : nothing}
        autocomplete="off"
        maxlength="160"
        ?disabled=${this.disabled}
        .value=${this.query}
        placeholder=${t("skillHubPage.searchUsers")}
        @compositionstart=${(event: CompositionEvent) =>
          this.updateQuery((event.target as HTMLInputElement).value, true)}
        @compositionend=${(event: CompositionEvent) =>
          this.updateQuery((event.target as HTMLInputElement).value)}
        @input=${(event: InputEvent) =>
          this.updateQuery((event.target as HTMLInputElement).value, event.isComposing)}
        @keydown=${(event: KeyboardEvent) => this.keydown(event)}
      />
      <div
        id=${id}
        class="skill-hub-user-results"
        role="listbox"
        aria-label=${label}
        ?hidden=${!open}
      >
        ${this.candidates.map(
          (user, index) => html`<button
            type="button"
            role="option"
            id=${`${id}-${index}`}
            class="skill-hub-user-option"
            tabindex="-1"
            aria-selected=${index === this.activeIndex ? "true" : "false"}
            ?disabled=${this.disabled}
            @mousedown=${(event: MouseEvent) => event.preventDefault()}
            @click=${() => this.choose(user)}
          >
            <strong>${user.displayName ?? user.accountId}</strong><span>${user.accountId}</span>
          </button>`,
        )}
      </div>
      <small id=${`${id}-help`} class="muted">${t("skillHubPage.userSearchHelp")}</small>
      <span role="status" aria-busy=${this.loading ? "true" : "false"}>
        ${this.loading
          ? t("skillsPage.searching")
          : this.searched && !this.candidates.length
            ? t("skillHubPage.noEligibleUsers")
            : nothing}
      </span>
      ${this.error ? html`<span class="callout danger" role="alert">${this.error}</span>` : nothing}
    </div>`;
  }
}

customElements.define("openclaw-skill-hub-user-picker", SkillHubUserPicker);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-skill-hub-user-picker": SkillHubUserPicker;
  }
}
