// Control UI i18n module implements registry behavior.
import { DEFAULT_LOCALE, isSupportedLocale } from "./locale-preferences.ts";
import type { Locale, TranslationMap } from "./types.ts";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  resolveNavigatorLocale,
} from "./locale-preferences.ts";

type LazyLocale = Exclude<Locale, "en">;
type LocaleModule = Record<string, TranslationMap>;

const LAZY_LOCALE_REGISTRY: Record<LazyLocale, () => Promise<LocaleModule>> = {
  "zh-CN": () => import("../locales/zh-CN.ts"),
  "zh-TW": () => import("../locales/zh-TW.ts"),
  "pt-BR": () => import("../locales/pt-BR.ts"),
  de: () => import("../locales/de.ts"),
  es: () => import("../locales/es.ts"),
  "ja-JP": () => import("../locales/ja-JP.ts"),
  ko: () => import("../locales/ko.ts"),
  fr: () => import("../locales/fr.ts"),
  hi: () => import("../locales/hi.ts"),
  ar: () => import("../locales/ar.ts"),
  it: () => import("../locales/it.ts"),
  tr: () => import("../locales/tr.ts"),
  uk: () => import("../locales/uk.ts"),
  id: () => import("../locales/id.ts"),
  pl: () => import("../locales/pl.ts"),
  th: () => import("../locales/th.ts"),
  vi: () => import("../locales/vi.ts"),
  nl: () => import("../locales/nl.ts"),
  fa: () => import("../locales/fa.ts"),
  ru: () => import("../locales/ru.ts"),
};

function isLazyLocale(locale: Locale): locale is LazyLocale {
  return locale !== DEFAULT_LOCALE && isSupportedLocale(locale);
}

export async function loadLazyLocaleTranslation(locale: Locale): Promise<TranslationMap | null> {
  if (!isLazyLocale(locale)) {
    return null;
  }
  const module = await LAZY_LOCALE_REGISTRY[locale]();
  return module[locale.replaceAll("-", "_")] ?? null;
}
