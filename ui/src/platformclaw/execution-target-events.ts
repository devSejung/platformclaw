export const PLATFORMCLAW_EXECUTION_TARGET_CHANGED_EVENT = "platformclaw:execution-target-changed";

export function notifyPlatformClawExecutionTargetChanged(): void {
  window.dispatchEvent(new Event(PLATFORMCLAW_EXECUTION_TARGET_CHANGED_EVENT));
}
