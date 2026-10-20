import { getSafeLocalStorage } from "../local-storage.ts";
import { syncCustomThemeStyleTag, type ImportedCustomTheme } from "./custom-theme.ts";
import { deriveDefaultGatewayUrl, readSelectedSettings } from "./settings-storage.ts";
import { parseThemePreferences } from "./theme-preferences.ts";
import { resolveTheme, type ThemeMode, type ThemeName } from "./theme.ts";

export function applyThemePresentation(settings: {
  theme: ThemeName;
  themeMode: ThemeMode;
  customTheme?: ImportedCustomTheme;
  textScale?: number;
}): void {
  if (typeof document === "undefined") {
    return;
  }
  const resolved = resolveTheme(settings.theme, settings.themeMode);
  const mode = resolved.endsWith("light") ? "light" : "dark";
  const root = document.documentElement;
  syncCustomThemeStyleTag(settings.customTheme);
  root.dataset.theme = resolved;
  root.dataset.themeMode = mode;
  // Carapace selects on data-theme-resolved; Web Awesome uses the wa classes.
  // First paint and live theme changes must update all consumers together.
  root.dataset.themeResolved = mode;
  root.classList.toggle("wa-light", mode === "light");
  root.classList.toggle("wa-dark", mode === "dark");
  root.style.colorScheme = mode;
  root.style.setProperty("--control-ui-text-scale", `${(settings.textScale ?? 100) / 100}`);
}

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
  applyThemePresentation(parseThemePreferences(stored));
}
