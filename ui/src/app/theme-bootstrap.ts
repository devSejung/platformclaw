import { getSafeLocalStorage } from "../local-storage.ts";
import { syncCustomThemeStyleTag } from "./custom-theme.ts";
import { deriveDefaultGatewayUrl, readSelectedSettings } from "./settings-storage.ts";
import { parseThemePreferences } from "./theme-preferences.ts";
import { resolveTheme } from "./theme.ts";

export function applyStoredTheme(basePath: string): void {
  let stored: Parameters<typeof parseThemePreferences>[0] = null;
  try {
    // First paint must use the same selected Gateway and parser as the app.
    // Auth/session state is never needed to resolve appearance.
    const { pageUrl, effectiveUrl } = deriveDefaultGatewayUrl(basePath);
    stored = readSelectedSettings(getSafeLocalStorage(), pageUrl, effectiveUrl)?.parsed ?? null;
  } catch {
    // Blocked browser storage keeps the same fresh-profile defaults as the app.
  }
  const preferences = parseThemePreferences(stored);
  const resolved = resolveTheme(preferences.theme, preferences.themeMode);
  const root = document.documentElement;
  syncCustomThemeStyleTag(preferences.customTheme);
  root.dataset.theme = resolved;
  root.dataset.themeMode = resolved.endsWith("light") ? "light" : "dark";
  root.dataset.themeResolved = root.dataset.themeMode;
  root.style.colorScheme = root.dataset.themeMode;
}
