export function isBaseballInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "input, textarea, select, button, label, a, [contenteditable], [role='button'], [role='link'], [role='menuitem'], [role='option'], [role='combobox'], [role='dialog']",
      ),
    )
  );
}

export function createBaseballRequestId(random: () => number): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `baseball-${Date.now()}-${random().toString(36).slice(2)}`
  );
}

export function isBaseballSwingZone(event: PointerEvent, player: HTMLElement | null): boolean {
  if (event.clientY < window.innerHeight * 0.7) {
    return false;
  }
  const rect = player?.getBoundingClientRect();
  return Boolean(rect && event.clientX >= rect.left - 96 && event.clientX <= rect.right + 96);
}

export function focusBaseballShop(host: HTMLElement): void {
  host.querySelector<HTMLElement>('[role="dialog"] button')?.focus();
}

export function handleBaseballKeydown(
  host: HTMLElement,
  event: KeyboardEvent,
  shopOpen: boolean,
  closeShop: (event: Event) => void,
  finishGame: () => void,
  swing: (event: Event) => void,
): void {
  if (event.key === "Escape" && shopOpen) {
    closeShop(event);
    return;
  }
  if (shopOpen) {
    trapBaseballShopFocus(host, event);
    return;
  }
  if (
    isBaseballInteractiveTarget(event.target) &&
    !(event.key === "Escape" && event.target instanceof Node && host.contains(event.target))
  ) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    finishGame();
  } else if (event.code === "Space" && !event.repeat && !event.defaultPrevented) {
    swing(event);
  }
}

function trapBaseballShopFocus(host: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab") {
    return;
  }
  const controls = Array.from(
    host.querySelectorAll<HTMLElement>(
      '[role="dialog"] button:not(:disabled), [role="dialog"] input, [role="dialog"] select',
    ),
  );
  const first = controls[0];
  const last = controls.at(-1);
  const active = document.activeElement;
  if (
    event.shiftKey
      ? active === first || !controls.includes(active as HTMLElement)
      : active === last || !controls.includes(active as HTMLElement)
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
}

/** One owner attaches and releases arcade input together, including an in-flight pointer gesture. */
export class ArcadeInputController {
  private pointerId: number | null = null;
  constructor(
    private readonly view: {
      host: HTMLElement;
      active: () => boolean;
      selector: () => boolean;
      shopOpen: () => boolean;
      player: () => HTMLElement | null;
      swing: (event: Event) => void;
      closeShop: (event: Event) => void;
      close: () => void;
    },
  ) {}

  connect(): void {
    window.addEventListener("keydown", this.keydown, true);
    window.addEventListener("pointerdown", this.pointerdown, true);
    window.addEventListener("pointerup", this.pointerup, true);
    window.addEventListener("pointercancel", this.pointercancel, true);
  }

  disconnect(): void {
    window.removeEventListener("keydown", this.keydown, true);
    window.removeEventListener("pointerdown", this.pointerdown, true);
    window.removeEventListener("pointerup", this.pointerup, true);
    window.removeEventListener("pointercancel", this.pointercancel, true);
    this.reset();
  }

  reset(): void {
    this.pointerId = null;
  }

  private readonly keydown = (event: KeyboardEvent): void => {
    if (this.view.selector()) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.view.close();
      } else if (event.key === "Tab") {
        const buttons = Array.from(
          this.view.host.querySelectorAll<HTMLButtonElement>(".platformclaw-games button"),
        );
        const target = event.shiftKey ? buttons.at(-1) : buttons[0];
        if (document.activeElement === (event.shiftKey ? buttons[0] : buttons.at(-1))) {
          event.preventDefault();
          target?.focus();
        }
      }
    } else if (this.view.active()) {
      handleBaseballKeydown(
        this.view.host,
        event,
        this.view.shopOpen(),
        this.view.closeShop,
        this.view.close,
        this.view.swing,
      );
    }
  };

  private readonly pointerdown = (event: PointerEvent): void => {
    if (
      this.view.active() &&
      !this.view.shopOpen() &&
      !isBaseballInteractiveTarget(event.target) &&
      isBaseballSwingZone(event, this.view.player())
    ) {
      this.pointerId = event.pointerId;
    }
  };

  private readonly pointerup = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) {
      return;
    }
    this.reset();
    if (!this.view.shopOpen() && isBaseballSwingZone(event, this.view.player())) {
      this.view.swing(event);
    }
  };

  private readonly pointercancel = (event: PointerEvent): void => {
    if (this.pointerId === event.pointerId) {
      this.reset();
    }
  };
}
