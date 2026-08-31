import { i18n, t } from "../i18n/index.ts";
import { resolveProductDisplayText } from "./branding.ts";

type PlatformClawKoreanBundle = typeof import("./locales/ko.ts");
type PlatformClawEnglishGuideBundle = typeof import("./locales/en-guide.ts");

let koreanBundle: PlatformClawKoreanBundle | undefined;
let koreanBundlePromise: Promise<void> | undefined;
let englishGuideBundle: PlatformClawEnglishGuideBundle | undefined;
let englishGuideBundlePromise: Promise<void> | undefined;

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
  koreanBundlePromise ??= import("./locales/ko.ts").then((bundle) => {
    koreanBundle = bundle;
  });
  await koreanBundlePromise;
}

export async function loadAllPlatformClawLocales(): Promise<void> {
  koreanBundlePromise ??= import("./locales/ko.ts").then((bundle) => {
    koreanBundle = bundle;
  });
  englishGuideBundlePromise ??= import("./locales/en-guide.ts").then((bundle) => {
    englishGuideBundle = bundle;
  });
  await Promise.all([koreanBundlePromise, englishGuideBundlePromise]);
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
