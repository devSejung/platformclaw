// Control UI adapter for Web Awesome's accessible modal dialog.
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import { css, html, nothing } from "lit";
import { property, query } from "lit/decorators.js";
import { wasPointerActivation } from "../lib/pointer-activation.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

/** Keep one modal instance while an owner switches loading, error, and content templates. */
export function renderModalDialog(options: {
  label: string;
  className?: string;
  style?: string;
  onCancel: (event: Event) => unknown;
  content: unknown;
}) {
  return html`<openclaw-modal-dialog
    label=${options.label}
    class=${options.className ?? nothing}
    style=${options.style ?? nothing}
    @modal-cancel=${options.onCancel}
    >${options.content}</openclaw-modal-dialog
  >`;
}

// Settings Escape must still see a pending modal after disabling its focused
// action moves focus to body; the native dialog itself lives in a shadow root.
export function hasOpenModalDialog(): boolean {
  // The browser retains a defined custom-element constructor across Vite HMR
  // and test module reloads, so its registry remains the authoritative one.
  const registeredConstructor = customElements.get("openclaw-modal-dialog") as
    | typeof OpenClawModalDialog
    | undefined;
  return (registeredConstructor ?? OpenClawModalDialog).hasOpenDialogs();
}

export class OpenClawModalDialog extends OpenClawLitElement {
  static readonly #openDialogs = new Set<OpenClawModalDialog>();

  static hasOpenDialogs(): boolean {
    return this.#openDialogs.size > 0;
  }

  @property({ type: Boolean }) open = true;
  @property({ type: Boolean, reflect: true }) manual = false;
  @property() label = "";
  @property() description = "";

  @query("wa-dialog") private webAwesomeDialog?: WaDialog;

  private returnFocus: HTMLElement | null = null;
  private returnFocusOverride: HTMLElement | null | undefined;
  private syncGeneration = 0;
  private suppressNextCancel = false;
  private hiding = false;
  private focusGeneration = 0;

  static override styles = css`
    :host {
      display: contents;
    }

    slot[data-focus-pending] {
      visibility: hidden;
    }

    wa-dialog {
      --width: min(var(--openclaw-modal-width, 540px), calc(100vw - 48px));
      --spacing: 0;
      --backdrop-filter: var(--openclaw-modal-backdrop-filter, blur(4px));
    }

    wa-dialog::part(dialog) {
      max-width: var(--openclaw-modal-max-width, calc(100vw - 48px));
      max-height: var(--openclaw-modal-max-height, calc(100dvh - 48px));
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--text);
      overflow: visible;
      /* Web Awesome waits for animationend on this node, not transitionend.
         Keep entry on its body so show/hide always finish their native lifecycle. */
      animation: none;
    }

    wa-dialog::part(dialog)::backdrop {
      animation: none;
    }

    @media (prefers-reduced-motion: no-preference) {
      :host([data-pointer-motion]) wa-dialog::part(body) {
        opacity: 1;
        transform: scale(1);
        transition:
          transform var(--duration-normal) var(--ease-out),
          opacity var(--duration-normal) var(--ease-out);

        @starting-style {
          opacity: 0;
          transform: scale(0.97);
        }
      }

      :host(.drawer[data-pointer-motion]) wa-dialog::part(body) {
        transform: translateX(0);

        @starting-style {
          opacity: 0.85;
          transform: translateX(8px);
        }
      }
    }

    wa-dialog::part(body) {
      padding: 0;
      overflow: visible;
    }

    :host(.fullscreen) wa-dialog {
      --width: calc(100vw - 20px);
    }

    :host(.fullscreen) wa-dialog::part(dialog) {
      max-height: calc(100dvh - 20px);
    }

    :host(.palette) wa-dialog::part(dialog) {
      margin-block-start: min(20dvh, 160px);
      margin-block-end: auto;
    }

    :host(.drawer) wa-dialog::part(dialog) {
      height: 100dvh;
      max-height: 100dvh;
      margin: 0 0 0 auto;
      border-radius: 0;
    }

    :host(.nav-drawer) wa-dialog {
      --width: min(86vw, 320px);
    }

    :host(.nav-drawer) wa-dialog::part(dialog) {
      max-width: min(86vw, 320px);
      margin: 0 auto 0 0;
    }

    :host(.nav-drawer) wa-dialog::part(body) {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    ::slotted(.shell-nav-modal__content) {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      min-width: 0;
    }

    @media (max-width: 640px) {
      wa-dialog {
        --width: calc(100vw - 24px);
      }

      wa-dialog::part(dialog) {
        max-height: 90dvh;
      }
    }
  `;

  override connectedCallback() {
    if (this.manual) {
      this.open = false;
    }
    super.connectedCallback();
    void this.updateComplete.then(() => this.syncDialogOpen());
  }

  override disconnectedCallback() {
    this.syncGeneration += 1;
    this.focusGeneration += 1;
    this.setContentReady(false);
    this.hiding = false;
    this.suppressNextCancel = false;
    OpenClawModalDialog.#openDialogs.delete(this);
    const webAwesomeDialog = this.webAwesomeDialog;
    const dialog = webAwesomeDialog?.shadowRoot?.querySelector("dialog");
    if (dialog?.open) {
      dialog.close();
    }
    if (webAwesomeDialog) {
      webAwesomeDialog.open = false;
    }
    const returnFocus =
      this.returnFocusOverride === undefined ? this.returnFocus : this.returnFocusOverride;
    this.returnFocus = null;
    this.returnFocusOverride = undefined;
    if (returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
    super.disconnectedCallback();
  }

  override render() {
    return html`
      <wa-dialog
        without-header
        light-dismiss
        .label=${this.label}
        @wa-show=${this.handleShow}
        @wa-after-show=${this.handleAfterShow}
        @wa-after-hide=${this.handleAfterHide}
        @wa-hide=${this.handleHide}
      >
        <slot inert data-focus-pending></slot>
      </wa-dialog>
    `;
  }

  protected override updated() {
    void this.syncAccessibility();
    void this.syncDialogOpen();
  }

  private async syncDialogOpen() {
    const generation = ++this.syncGeneration;
    const webAwesomeDialog = this.webAwesomeDialog;
    if (!webAwesomeDialog) {
      return;
    }
    await webAwesomeDialog.updateComplete;
    if (generation !== this.syncGeneration || !this.isConnected) {
      return;
    }
    const dialog = webAwesomeDialog.shadowRoot?.querySelector("dialog");
    if (this.open) {
      if (dialog?.open) {
        return;
      }
      // A reopen requested during hide keeps the original trigger until the
      // eventual close; the dependency may still have a focus-restore task queued.
      this.returnFocus ??=
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      webAwesomeDialog.open = true;
      return;
    }
    // An accepted native dismissal keeps its dialog open through the hide animation.
    // An owner's .open=false echo must not start a second Web Awesome close request.
    if (!this.hiding && (webAwesomeDialog.open || dialog?.open)) {
      this.suppressNextCancel = true;
      webAwesomeDialog.open = false;
    }
  }

  private async syncAccessibility() {
    const webAwesomeDialog = this.webAwesomeDialog;
    if (!webAwesomeDialog) {
      return;
    }
    await webAwesomeDialog.updateComplete;
    const dialog = webAwesomeDialog.shadowRoot?.querySelector("dialog");
    if (!dialog) {
      return;
    }
    if (this.label) {
      dialog.setAttribute("aria-label", this.label);
    } else {
      dialog.removeAttribute("aria-label");
    }
    if (this.description) {
      dialog.setAttribute("aria-description", this.description);
    } else {
      dialog.removeAttribute("aria-description");
    }
  }

  private setContentReady(ready: boolean): void {
    const slot = this.shadowRoot?.querySelector("slot");
    if (slot) {
      slot.inert = !ready;
      slot.toggleAttribute("data-focus-pending", !ready);
    }
  }

  private handleAfterShow = (event?: Event) => {
    if (event && event.target !== event.currentTarget) {
      return;
    }
    if (!this.isConnected || this.shadowRoot?.querySelector("slot[data-focus-pending]")) {
      return;
    }
    // Both the scheduled show hook and wa-after-show land here, and the second
    // arrives after the open animation. If focus already moved to a slotted
    // field (user click, autofill, e2e input), refocusing the autofocus target
    // would steal it mid-typing; `this` means focus sits on dialog chrome.
    let active = document.activeElement;
    while (active) {
      if (active instanceof HTMLElement && active !== this && this.contains(active)) {
        return;
      }
      active = active.shadowRoot?.activeElement ?? null;
    }
    const autofocusTarget = this.querySelector<HTMLElement>("[autofocus]");
    autofocusTarget?.focus({ preventScroll: true });
  };

  private handleShow = (event: Event) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    this.toggleAttribute(
      "data-pointer-motion",
      wasPointerActivation() && !this.matches(".palette, .nav-drawer"),
    );
    // Web Awesome focuses native chrome in its first animation frame because it
    // cannot see slotted autofocus fields. Expose inputs only after that frame
    // so its focus cannot redirect typing into the wrong field.
    const generation = ++this.focusGeneration;
    this.setContentReady(false);
    queueMicrotask(() => {
      // A different owner may cancel wa-show after this adapter observes it.
      if (!event.defaultPrevented && this.isConnected) {
        OpenClawModalDialog.#openDialogs.add(this);
      }
      requestAnimationFrame(() => {
        if (event.defaultPrevented || !this.isConnected || generation !== this.focusGeneration) {
          return;
        }
        this.setContentReady(true);
        this.handleAfterShow();
      });
    });
  };

  private handleAfterHide = (event: Event) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    this.hiding = false;
    this.setContentReady(false);
    OpenClawModalDialog.#openDialogs.delete(this);
    // Web Awesome completes requestClose after awaiting its hide animation. An
    // owner may already have requested another open while native dialog.open was
    // still true. Reconcile that request instead of overwriting it with this hide.
    if (this.open) {
      void this.syncDialogOpen();
      return;
    }
    const returnFocus = this.returnFocusOverride;
    const originalReturnFocus = this.returnFocus;
    this.returnFocusOverride = undefined;
    this.returnFocus = null;
    if (returnFocus === undefined) {
      return;
    }
    // Web Awesome queues its original-trigger restoration immediately before
    // wa-after-hide; apply the owner's restoration or suppression after it.
    setTimeout(() => {
      if (returnFocus === null) {
        if (originalReturnFocus && document.activeElement === originalReturnFocus) {
          originalReturnFocus.blur();
        }
      } else if (returnFocus.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
    }, 0);
  };

  private handleHide = (event: Event) => {
    // Nested overlay lifecycle events bubble through the slot; only the
    // dialog's own hide may dismiss or steal focus from its owner.
    if (event.target !== event.currentTarget) {
      return;
    }
    // Closing retires visual entry immediately; no private content is retained for exit.
    this.removeAttribute("data-pointer-motion");
    if (this.suppressNextCancel) {
      this.focusGeneration += 1;
      this.suppressNextCancel = false;
      this.hiding = true;
      return;
    }
    const cancelEvent = new CustomEvent("modal-cancel", {
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    this.dispatchEvent(cancelEvent);
    if (cancelEvent.defaultPrevented) {
      event.preventDefault();
      return;
    }
    // Record accepted dismissal now so a later owner reopen is distinguishable
    // from the old dialog's open state when wa-after-hide eventually arrives.
    this.open = false;
    this.focusGeneration += 1;
    this.hiding = true;
  };

  show() {
    this.open = true;
  }

  setReturnFocusTarget(target: HTMLElement | null) {
    this.returnFocusOverride = target;
  }

  hide() {
    this.open = false;
  }
}

if (!customElements.get("openclaw-modal-dialog")) {
  customElements.define("openclaw-modal-dialog", OpenClawModalDialog);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-modal-dialog": OpenClawModalDialog;
  }
}
