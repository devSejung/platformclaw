import { getSafeLocalStorage } from "../../local-storage.ts";
import type { Locale } from "./types.ts";

export const LOCALE_STORAGE_KEY = "openclaw.i18n.locale";
export const DEFAULT_LOCALE: Locale = "en";

// Preference resolution also runs before the standalone login's first paint.
// Keep locale identity independent of the Control UI's lazy translation loaders.
const LAZY_LOCALES: readonly Exclude<Locale, "en">[] = [
  "zh-CN",
  "zh-TW",
  "pt-BR",
  "de",
  "es",
  "ja-JP",
  "ko",
  "fr",
  "hi",
  "ar",
  "it",
  "tr",
  "uk",
  "id",
  "pl",
  "th",
  "vi",
  "nl",
  "fa",
  "ru",
];

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = [DEFAULT_LOCALE, ...LAZY_LOCALES];

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && SUPPORTED_LOCALES.includes(value as Locale);
}

export function resolveNavigatorLocale(browserLanguage: string): Locale {
  const navLang = browserLanguage.toLowerCase();
  if (navLang.startsWith("zh")) {
    const [, ...subtags] = navLang.split("-");
    if (subtags.includes("hant")) {
      return "zh-TW";
    }
    if (subtags.includes("hans")) {
      return "zh-CN";
    }
    return subtags.some((subtag) => subtag === "tw" || subtag === "hk" || subtag === "mo")
      ? "zh-TW"
      : "zh-CN";
  }
  return (
    LAZY_LOCALES.find((locale) => navLang.startsWith(locale.split("-")[0]!.toLowerCase())) ??
    DEFAULT_LOCALE
  );
}

export function resolveInitialLocalePreference(): { locale: Locale; shouldPersist: boolean } {
  let saved: string | null = null;
  try {
    saved = getSafeLocalStorage()?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    // Blocked browser storage follows system language without persisting it.
  }
  if (isSupportedLocale(saved)) {
    return { locale: saved, shouldPersist: true };
  }
  const language =
    typeof globalThis.navigator?.language === "string" ? globalThis.navigator.language : "";
  return { locale: resolveNavigatorLocale(language), shouldPersist: false };
}
