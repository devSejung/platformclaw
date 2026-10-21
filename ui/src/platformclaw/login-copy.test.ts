import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import loginHtml from "../../platformclaw-login.html?raw";
import { LOCALE_STORAGE_KEY } from "../i18n/lib/locale-preferences.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { applyPlatformClawLoginCopy } from "./login-copy.ts";

let previousDocumentLocale: { title: string; lang: string; dir: string };

function fixture(): HTMLElement {
  const page = new DOMParser().parseFromString(loginHtml, "text/html");
  const root = page.querySelector<HTMLElement>("main")!;
  document.body.append(root);
  return root;
}

beforeEach(() => {
  previousDocumentLocale = {
    title: document.title,
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
  };
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("navigator", { language: "ko-KR" });
});

afterEach(() => {
  document.body.replaceChildren();
  document.title = previousDocumentLocale.title;
  document.documentElement.lang = previousDocumentLocale.lang;
  document.documentElement.dir = previousDocumentLocale.dir;
  vi.unstubAllGlobals();
});

describe("login copy", () => {
  it("uses saved English across the form, guide and one security notice on a Korean browser", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    const root = fixture();
    applyPlatformClawLoginCopy(document);
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.title).toBe("PlatformClaw sign in");
    expect(root.textContent).not.toMatch(/[가-힣]/u);
    expect(root.querySelector('input[name="password"]')?.getAttribute("placeholder")).toBe(
      "Password",
    );
    expect(root.querySelector("[data-login-guide-close]")?.getAttribute("aria-label")).toBe(
      "Close video",
    );
    expect(root.querySelector("[data-login-guide-video]")?.getAttribute("aria-label")).toBe(
      "PlatformClaw guide video",
    );
    const notice = root.querySelector(".login-security-notice")!;
    expect(notice.querySelectorAll("p")).toHaveLength(1);
    expect(notice.textContent).toContain("Regular conversations are processed by our internal LLM");
    expect(notice.textContent).toContain("external Claude via ACP");
  });

  it("uses source-owned Korean and preserves entered credentials", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    localStorage.setItem(LOCALE_STORAGE_KEY, "ko");
    const root = fixture();
    const password = root.querySelector<HTMLInputElement>('input[name="password"]')!;
    password.value = "fixture-only";
    applyPlatformClawLoginCopy(document);
    expect(document.documentElement.lang).toBe("ko");
    expect(document.title).toBe("PlatformClaw 로그인");
    expect(root.querySelector(".login-security-notice")?.textContent).toContain(
      "사용 전 Claude 설정과 사내 보안 정책을 반드시 확인해 주세요.",
    );
    expect(password.value).toBe("fixture-only");
  });

  it("uses browser language in system mode and English for other product languages without storing a preference", () => {
    const root = fixture();
    applyPlatformClawLoginCopy(document);
    expect(document.documentElement.lang).toBe("ko");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
    applyPlatformClawLoginCopy(document);
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ar");
    expect(root.querySelector("[data-login-copy=subtitle]")?.textContent).toBe(
      "Sign in to your workspace with your work account.",
    );
  });

  it("updates SVG and HTML shadow copy without replacing animated nodes", () => {
    const root = document.createElement("div");
    const shadow = root.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<svg><text data-login-copy="heroTools">도구</text></svg><button data-login-copy-aria-label="pauseAnimation">Ⅱ</button>';
    const label = shadow.querySelector("text");
    const button = shadow.querySelector("button");
    applyPlatformClawLoginCopy(shadow, "en");
    expect(shadow.querySelector("text")).toBe(label);
    expect(label?.textContent).toBe("Tools");
    expect(button?.getAttribute("aria-label")).toBe("Pause animation");
    applyPlatformClawLoginCopy(shadow, "ko");
    expect(label?.textContent).toBe("도구");
  });
});
