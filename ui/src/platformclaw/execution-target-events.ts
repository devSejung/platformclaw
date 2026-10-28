const PLATFORMCLAW_EXECUTION_TARGET_CHANGED_EVENT = "platformclaw:execution-target-changed";
const PLATFORMCLAW_EXECUTION_SETTINGS_CHANGED_EVENT = "platformclaw:execution-settings-changed";

export function notifyPlatformClawExecutionSettingsChanged(): void {
  window.dispatchEvent(new Event(PLATFORMCLAW_EXECUTION_SETTINGS_CHANGED_EVENT));
}

export function subscribeToPlatformClawExecutionSettingsChanges(
  target: Window,
  refresh: () => void,
): () => void {
  target.addEventListener(PLATFORMCLAW_EXECUTION_SETTINGS_CHANGED_EVENT, refresh);
  return () => target.removeEventListener(PLATFORMCLAW_EXECUTION_SETTINGS_CHANGED_EVENT, refresh);
}

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
