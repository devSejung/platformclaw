export const PLATFORMCLAW_EXECUTION_TARGET_CHANGED_EVENT = "platformclaw:execution-target-changed";

export function notifyPlatformClawExecutionTargetChanged(): void {
  window.dispatchEvent(new Event(PLATFORMCLAW_EXECUTION_TARGET_CHANGED_EVENT));
}

export function subscribeToPlatformClawExecutionTargetChanges(
  target: Window,
  reset: () => void,
  load: () => void,
): () => void {
  const refresh = () => {
    reset();
    load();
  };
  target.addEventListener(PLATFORMCLAW_EXECUTION_TARGET_CHANGED_EVENT, refresh);
  return () => target.removeEventListener(PLATFORMCLAW_EXECUTION_TARGET_CHANGED_EVENT, refresh);
}
