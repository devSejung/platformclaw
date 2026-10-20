import { parseImportedCustomTheme } from "./custom-theme.ts";
import { parseThemeSelection } from "./theme.ts";

export const THEME_PREFERENCE_DEFAULTS = { theme: "platformclaw", themeMode: "light" } as const;

export function parseThemePreferences(
  stored: { theme?: unknown; themeMode?: unknown; customTheme?: unknown } | null,
) {
  if (!stored) {
    return { ...THEME_PREFERENCE_DEFAULTS, customTheme: undefined };
  }
  const customTheme = parseImportedCustomTheme(stored.customTheme) ?? undefined;
  const { theme, mode } = parseThemeSelection(stored.theme, stored.themeMode);
  return {
    theme: theme === "custom" && !customTheme ? THEME_PREFERENCE_DEFAULTS.theme : theme,
    themeMode: mode,
    customTheme,
  };
}
