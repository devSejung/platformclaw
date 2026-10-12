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
