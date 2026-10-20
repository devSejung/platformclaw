import { applyStoredTheme } from "../app/theme-bootstrap.ts";
import { PLATFORMCLAW_APP_PATH } from "./web-contract.ts";

export function installPlatformClawLoginTheme(): () => void {
  const apply = () => applyStoredTheme(PLATFORMCLAW_APP_PATH);
  apply();
  const system = globalThis.matchMedia?.("(prefers-color-scheme: light)");
  system?.addEventListener("change", apply);
  window.addEventListener("storage", apply);
  const dispose = () => {
    system?.removeEventListener("change", apply);
    window.removeEventListener("storage", apply);
  };
  return dispose;
}
