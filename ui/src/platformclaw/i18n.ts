import { i18n, t, type TranslationMap } from "../i18n/index.ts";
import { loadLazyLocaleTranslation } from "../i18n/lib/registry.ts";
import { resolveProductDisplayText } from "./branding.ts";

type PlatformClawKoreanBundle = typeof import("./locales/ko.ts");
type PlatformClawEnglishGuideBundle = typeof import("./locales/en-guide.ts");

let koreanBundle: PlatformClawKoreanBundle | undefined;
let koreanBundlePromise: Promise<void> | undefined;
let englishGuideBundle: PlatformClawEnglishGuideBundle | undefined;
let englishGuideBundlePromise: Promise<void> | undefined;

function mergeNativeTranslations(base: TranslationMap, overrides: TranslationMap): TranslationMap {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = merged[key];
    merged[key] =
      typeof value === "string"
        ? value
        : mergeNativeTranslations(typeof existing === "object" ? existing : {}, value);
  }
  return merged;
}

function loadKoreanBundle(): Promise<void> {
  koreanBundlePromise ??= Promise.all([import("./locales/ko.ts"), loadLazyLocaleTranslation("ko")])
    .then(([bundle, base]) => {
      if (!base) {
        throw new Error("Korean locale is unavailable");
      }
      const translations = mergeNativeTranslations(base, bundle.nativeTranslations);
      i18n.registerTranslation("ko", translations);
      koreanBundle = bundle;
    })
    .catch((error: unknown) => {
      koreanBundlePromise = undefined;
      throw error;
    });
  return koreanBundlePromise;
}

export async function loadPlatformClawLocale(): Promise<void> {
  if (i18n.getLocale() !== "ko") {
    if (englishGuideBundle) {
      return;
    }
    englishGuideBundlePromise ??= import("./locales/en-guide.ts").then((bundle) => {
      englishGuideBundle = bundle;
    });
    await englishGuideBundlePromise;
    return;
  }
  if (koreanBundle) {
    return;
  }
  await loadKoreanBundle();
}

export async function loadAllPlatformClawLocales(): Promise<void> {
  englishGuideBundlePromise ??= import("./locales/en-guide.ts").then((bundle) => {
    englishGuideBundle = bundle;
  });
  await Promise.all([loadKoreanBundle(), englishGuideBundlePromise]);
}

export function platformClawT(key: string, params?: Record<string, string>): string {
  const value =
    i18n.getLocale() === "ko"
      ? koreanBundle?.translations[key]
      : englishGuideBundle?.translations[key];
  if (!value) {
    return t(key, params);
  }
  return params
    ? value.replace(/\{(\w+)\}/gu, (_, name: string) => params[name] ?? `{${name}}`)
    : value;
}

export function platformClawGuideT(key: string, params?: Record<string, string>): string {
  const value =
    i18n.getLocale() === "ko"
      ? koreanBundle?.translations[key]
      : englishGuideBundle?.translations[key];
  if (!value) {
    return t(key, params);
  }
  return params
    ? value.replace(/\{(\w+)\}/gu, (_, name: string) => params[name] ?? `{${name}}`)
    : value;
}

export function platformClawProductT(key: string, params?: Record<string, string>): string {
  const template = resolveProductDisplayText(platformClawT(key));
  return params
    ? template.replace(/\{(\w+)\}/gu, (_, name: string) => params[name] ?? `{${name}}`)
    : template;
}

export function platformClawStatus(value: string): string {
  return i18n.getLocale() === "ko" ? (koreanBundle?.statusLabels[value] ?? value) : value;
}
