import { afterEach, describe, expect, it, vi } from "vitest";
import loginHtml from "../../platformclaw-login.html?raw";
import { installPlatformClawLoginGuide } from "./login-guide.ts";

function credentialedGuideUrl(): string {
  const url = new URL("https://media.example.test/guide.mp4");
  url.username = "fixture-user";
  url.password = "fixture-password";
  return url.toString();
}

function fixture(url?: string) {
  const page = new DOMParser().parseFromString(loginHtml, "text/html");
  document.body.innerHTML = page.querySelector("main")!.outerHTML;
  if (url !== undefined) {
    const meta = document.createElement("meta");
    meta.name = "platformclaw-guide-video-url";
    meta.content = url;
    document.head.append(meta);
  }
  const section = document.querySelector<HTMLElement>("[data-login-guide]")!;
  const button = document.querySelector<HTMLButtonElement>("[data-login-guide-open]")!;
  const dialog = document.querySelector<HTMLDialogElement>("[data-login-guide-dialog]")!;
  const close = document.querySelector<HTMLButtonElement>("[data-login-guide-close]")!;
  const video = document.querySelector<HTMLVideoElement>("[data-login-guide-video]")!;
  const error = document.querySelector<HTMLElement>("[data-login-guide-error]")!;
  const link = document.querySelector<HTMLAnchorElement>("[data-login-guide-link]")!;
  // jsdom does not implement modal focus or media playback; Chromium E2E covers those.
  Object.defineProperties(dialog, {
    showModal: { value: vi.fn(() => (dialog.open = true)) },
    close: {
      value: () => {
        dialog.open = false;
        dialog.dispatchEvent(new Event("close"));
      },
    },
  });
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
  const load = vi.spyOn(video, "load").mockImplementation(() => {});
  installPlatformClawLoginGuide(document);
  return { section, button, dialog, close, video, error, link, pause, load };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.querySelector('meta[name="platformclaw-guide-video-url"]')?.remove();
});

describe("login guide video", () => {
  const sameOriginGuideUrl = `${window.location.origin}/platformclaw/guide/video`;
  it.each([
    undefined,
    "",
    "   ",
    "not-a-url",
    "/guide.mp4",
    "javascript:alert(1)",
    "data:video/mp4;base64,fixture",
    credentialedGuideUrl(),
    "https://different-origin.example.test/platformclaw/guide/video",
  ])("keeps the guide hidden for absent or unsafe configuration: %s", (url) => {
    const { section, video, link } = fixture(url);
    expect(section.hidden).toBe(true);
    expect(video.hasAttribute("src")).toBe(false);
    expect(link.hasAttribute("href")).toBe(false);
  });

  it("loads the same-origin media proxy only after an explicit click", () => {
    const { section, button, dialog, video, link } = fixture(sameOriginGuideUrl);
    const submit = vi.fn();
    document.querySelector("form")!.addEventListener("submit", submit);
    expect(section.hidden).toBe(false);
    expect(button.type).toBe("button");
    expect(button.closest("form")).toBeNull();
    expect(video.getAttribute("preload")).toBe("none");
    expect(video.hasAttribute("src")).toBe(false);
    expect(link.href).toBe(sameOriginGuideUrl);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    button.click();
    expect(dialog.open).toBe(true);
    expect(video.src).toBe(sameOriginGuideUrl);
    expect(video.autoplay).toBe(false);
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("stops and unloads on close, restores focus and preserves entered credentials", () => {
    const { button, dialog, close, video, pause, load } = fixture(sameOriginGuideUrl);
    const identifier = document.querySelector<HTMLInputElement>('input[name="identifier"]')!;
    const password = document.querySelector<HTMLInputElement>('input[name="password"]')!;
    identifier.value = "person.one";
    password.value = "fixture-only";
    button.click();
    close.click();
    expect(dialog.open).toBe(false);
    expect(pause).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    expect(video.hasAttribute("src")).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(identifier.value).toBe("person.one");
    expect(password.value).toBe("fixture-only");
  });

  it("shows a media failure without affecting login and retries cleanly when reopened", () => {
    const { button, close, video, error, link } = fixture(sameOriginGuideUrl);
    button.click();
    video.dispatchEvent(new Event("error"));
    expect(error.hidden).toBe(false);
    expect(link.href).toBe(sameOriginGuideUrl);
    expect(document.querySelector<HTMLElement>("[data-login-error]")!.hidden).toBe(true);
    close.click();
    button.click();
    expect(error.hidden).toBe(true);
    expect(video.src).toBe(sameOriginGuideUrl);
  });
});
