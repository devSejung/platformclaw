import { html, nothing } from "lit";

export type MemoryItemActions = {
  label: string;
  open: (lookup: string, event: Event) => void;
};

export function renderMemoryItemActions(lookup: string, actions?: MemoryItemActions) {
  return actions
    ? html`<button
        type="button"
        class="btn btn--subtle btn--sm memory-item-actions"
        aria-label=${actions.label}
        aria-haspopup="menu"
        @click=${(event: MouseEvent) => {
          event.stopPropagation();
          actions.open(lookup, event);
        }}
      >
        ⋯
      </button>`
    : nothing;
}
