import { html, nothing } from "lit";

export function renderMemberTargetSearch(options: {
  label: string;
  searchLabel: string;
  moreLabel: string;
  busy: boolean;
  hasMore: boolean;
  items: Array<{ id: string; label: string; detail: string; action: string; disabled?: boolean }>;
  onSearch: (query: string) => void;
  onSelect: (id: string) => void;
}) {
  return html`<form
      class="settings-row__controls"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const query = new FormData(event.currentTarget as HTMLFormElement).get("query");
        options.onSearch(typeof query === "string" ? query.trim() : "");
      }}
    >
      <input
        class="settings-input"
        name="query"
        maxlength="128"
        aria-label=${options.label}
        placeholder=${options.label}
        ?disabled=${options.busy}
      />
      <button class="btn btn--sm" type="submit" ?disabled=${options.busy}>
        ${options.searchLabel}
      </button>
    </form>
    ${options.items.map(
      (item) => html`<div class="settings-row__controls">
        <span><strong>${item.label}</strong> · ${item.detail}</span>
        <button
          class="btn btn--sm"
          ?disabled=${options.busy || item.disabled}
          @click=${() => options.onSelect(item.id)}
        >
          ${item.action}
        </button>
      </div>`,
    )}
    ${options.hasMore ? html`<p class="muted" role="status">${options.moreLabel}</p>` : nothing}`;
}
