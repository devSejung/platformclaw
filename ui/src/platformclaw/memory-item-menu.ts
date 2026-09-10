import { html } from "lit";
import { property } from "lit/decorators.js";
import { DropdownMenuController } from "../components/dropdown-menu-controller.ts";
import "../components/web-awesome.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT as t } from "./i18n.ts";

export type MemoryMenuAction = "delete" | "share";

class PlatformClawMemoryItemMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) x = 0;
  @property({ attribute: false }) y = 0;
  @property({ attribute: false }) trigger: HTMLElement | null = null;
  @property({ attribute: false }) actions: MemoryMenuAction[] = [];
  @property() kind: "memory" | "wiki" = "memory";
  @property({ attribute: false }) onAction: (action: MemoryMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};

  readonly menuLifecycle = new DropdownMenuController(this, {
    getTrigger: () => this.trigger,
    onClose: () => this.onClose(),
  });

  override render() {
    const x = Math.max(8, Math.min(this.x, window.innerWidth - 280));
    const y = Math.max(8, Math.min(this.y, window.innerHeight - 120));
    return html`<wa-dropdown
      class="session-menu"
      .open=${true}
      placement="bottom-start"
      .distance=${0}
      aria-label=${t("platformClaw.memory.actions")}
      @wa-select=${(event: CustomEvent<{ item: { value?: MemoryMenuAction } }>) => {
        event.preventDefault();
        const action = event.detail.item.value;
        if (!action || !this.actions.includes(action)) {
          return;
        }
        this.onClose();
        this.onAction(action);
      }}
      @wa-after-hide=${(event: Event) => {
        // A removed menu can finish hiding after its successor opens.
        // Only the connected dropdown may close the current menu.
        if (event.currentTarget instanceof Node && event.currentTarget.isConnected) {
          this.onClose();
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        tabindex="-1"
        aria-hidden="true"
        style="position: fixed; left: ${x}px; top: ${y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
      ></button>
      ${this.actions.map(
        (action) => html`<wa-dropdown-item value=${action}>
          ${t(
            action === "share"
              ? "platformClaw.memory.share"
              : this.kind === "wiki"
                ? "platformClaw.wiki.delete"
                : "platformClaw.memory.delete",
          )}
        </wa-dropdown-item>`,
      )}
    </wa-dropdown>`;
  }
}

if (!customElements.get("platformclaw-memory-item-menu")) {
  customElements.define("platformclaw-memory-item-menu", PlatformClawMemoryItemMenu);
}
