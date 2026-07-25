import { i18n, t } from "../i18n/index.ts";

type PlatformClawKoreanBundle = typeof import("./locales/ko.ts");

let koreanBundle: PlatformClawKoreanBundle | undefined;
let koreanBundlePromise: Promise<void> | undefined;

export async function loadPlatformClawLocale(): Promise<void> {
  if (i18n.getLocale() !== "ko" || koreanBundle) {
    return;
  }
  koreanBundlePromise ??= import("./locales/ko.ts").then((bundle) => {
    koreanBundle = bundle;
  });
  await koreanBundlePromise;
}

export function platformClawT(key: string, params?: Record<string, string>): string {
  const value = i18n.getLocale() === "ko" ? koreanBundle?.translations[key] : undefined;
  if (!value) {
    return t(key, params);
  }
  return params
    ? value.replace(/\{(\w+)\}/gu, (_, name: string) => params[name] ?? `{${name}}`)
    : value;
}

export function platformClawStatus(value: string): string {
  return i18n.getLocale() === "ko" ? (koreanBundle?.statusLabels[value] ?? value) : value;
}
