export const PLATFORMCLAW_EASTER_EGG_EVENT = "platformclaw:easter-egg";

const REQUIRED_CLICKS = 7;
const CLICK_WINDOW_MS = 3_000;

let clickCount = 0;
let lastClickAt = 0;

/** Counts quick logo taps without putting the secret gesture in app state. */
export function recordPlatformClawEasterEggClick(now = performance.now()): boolean {
  if (now - lastClickAt > CLICK_WINDOW_MS) {
    clickCount = 0;
  }
  lastClickAt = now;
  clickCount += 1;
  if (clickCount < REQUIRED_CLICKS) {
    return false;
  }
  clickCount = 0;
  void import("./easter-egg-game.ts")
    .then(() => window.dispatchEvent(new Event(PLATFORMCLAW_EASTER_EGG_EVENT)))
    .catch(() => undefined);
  return true;
}

/** Test-only reset hook; the gesture itself stays process-local and ephemeral. */
export function resetPlatformClawEasterEggClickCount(): void {
  clickCount = 0;
  lastClickAt = 0;
}
