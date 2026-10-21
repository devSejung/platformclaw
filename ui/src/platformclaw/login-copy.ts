import { resolveInitialLocalePreference } from "../i18n/lib/locale-preferences.ts";
import { enLoginCopy } from "./locales/en-login.ts";
import { koLoginCopy } from "./locales/ko-login.ts";

export type LoginCopyKey = keyof typeof enLoginCopy;
type LoginLocale = "en" | "ko";

function resolveLoginLocale(): LoginLocale {
  return resolveInitialLocalePreference().locale === "ko" ? "ko" : "en";
}

export function platformClawLoginT(key: LoginCopyKey, locale = resolveLoginLocale()): string {
  return (locale === "ko" ? koLoginCopy : enLoginCopy)[key];
}

export function applyPlatformClawLoginCopy(root: ParentNode, locale = resolveLoginLocale()): void {
  // Product copy has source-owned Korean and English bundles. Other supported
  // app languages use English here without replacing the user's saved choice.
  const copy = locale === "ko" ? koLoginCopy : enLoginCopy;
  for (const attribute of ["text", "placeholder", "aria-label"] as const) {
    const marker = attribute === "text" ? "data-login-copy" : `data-login-copy-${attribute}`;
    for (const element of root.querySelectorAll<HTMLElement | SVGElement>(`[${marker}]`)) {
      const key = element.getAttribute(marker);
      if (!key || !Object.hasOwn(copy, key)) {
        continue;
      }
      const value = copy[key as LoginCopyKey];
      if (attribute === "text") {
        element.textContent = value;
      } else {
        element.setAttribute(attribute, value);
      }
    }
  }
  if (root instanceof Document) {
    root.documentElement.lang = locale;
    root.documentElement.dir = "ltr";
    root.title = copy.pageTitle;
  }
}
