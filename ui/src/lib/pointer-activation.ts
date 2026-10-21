// Record activation before component handlers can render or focus a new surface.
// Keyboard and assistive clicks have detail=0 and must never inherit pointer motion.
let pointerActivation = false;

if (typeof document !== "undefined") {
  document.addEventListener("click", (event) => (pointerActivation = event.detail > 0), true);
  document.addEventListener("keydown", () => (pointerActivation = false), true);
}

export function wasPointerActivation(): boolean {
  return pointerActivation;
}
