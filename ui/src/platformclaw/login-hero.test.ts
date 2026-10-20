import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { installPlatformClawLoginHero } from "./login-hero.ts";

type Flow = {
  frames: Keyframe[];
  timing: KeyframeAnimationOptions;
  animation: {
    currentTime: number;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
};

let cleanup: (() => void) | undefined;
let flows: Flow[];
let reduced: boolean;
let hidden: boolean;
let media: EventTarget;

function mount() {
  document.body.innerHTML = `<main class="login-page"><section data-login-hero></section>
    <form><input name="identifier"/><input name="password"/></form><button>Other</button></main>`;
  const root = document.querySelector<HTMLElement>("[data-login-hero]")!;
  cleanup = installPlatformClawLoginHero(root);
  for (const path of root.shadowRoot!.querySelectorAll(".connector path")) {
    // jsdom has no SVG geometry implementation. Exercise the real motion owner
    // with per-instance browser API doubles; Chromium covers the authored paths.
    Object.assign(path, {
      getTotalLength: () => 200,
      getPointAtLength: (distance: number) => ({ x: 50 + distance, y: 100 }),
    });
  }
  return root;
}

function finishIntro(root: HTMLElement) {
  root.shadowRoot!.querySelector(".complete")!.dispatchEvent(new Event("animationend"));
}

describe("PlatformClaw login hero", () => {
  beforeEach(() => {
    flows = [];
    reduced = false;
    hidden = false;
    media = new EventTarget();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "ko-KR" });
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return reduced;
      },
      addEventListener: media.addEventListener.bind(media),
    }));
    const createElement = document.createElementNS.bind(document);
    vi.spyOn(document, "createElementNS").mockImplementation((namespace, name, options) => {
      const element = createElement(namespace, name, options);
      if (name === "circle") {
        Object.assign(element, {
          animate: (frames: Keyframe[], timing: KeyframeAnimationOptions) => {
            const animation = { currentTime: 0, play: vi.fn(), pause: vi.fn(), cancel: vi.fn() };
            flows.push({ frames, timing, animation });
            return animation;
          },
        });
      }
      return element;
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("isolates the workspace illustration from upstream UI styles", () => {
    const root = mount();

    expect(root.hasAttribute("aria-hidden")).toBe(false);
    expect(root.shadowRoot).not.toBeNull();
    expect(root.shadowRoot?.querySelector(".hero")).not.toBeNull();
    expect(root.shadowRoot?.querySelector("h1")?.textContent).toContain("완성된 업무로.");
    expect(root.shadowRoot?.querySelector("svg.workspace")?.getAttribute("viewBox")).toBe(
      "0 0 600 350",
    );
    expect(root.shadowRoot?.querySelector("style")?.textContent).toMatch(/:host\s*\{/u);
    expect(root.shadowRoot?.querySelector("svg.workspace")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(root.shadowRoot?.querySelector("[data-motion-toggle]")?.getAttribute("aria-label")).toBe(
      "애니메이션 일시정지",
    );
  });

  it("starts seamless, staggered flows only after the explanatory intro completes", () => {
    const root = mount();
    expect(flows).toHaveLength(0);
    finishIntro(root);
    expect(root.hasAttribute("data-motion-ready")).toBe(true);
    expect(flows).toHaveLength(4);
    expect(new Set(flows.map(({ timing }) => timing.duration)).size).toBe(4);
    for (const { frames, timing } of flows) {
      expect(timing).toMatchObject({ iterations: Infinity, easing: "linear" });
      expect(frames[0]).toMatchObject({ opacity: 0, transform: "translate(0px, 0px)" });
      expect(frames.at(-1)).toMatchObject({ opacity: 0, transform: "translate(200px, 0px)" });
    }
    finishIntro(root);
    expect(flows).toHaveLength(4);
  });

  it("pauses for input, visibility and the explicit control without rebuilding the timeline", async () => {
    const root = mount();
    finishIntro(root);
    const animation = flows[0]!.animation;
    animation.currentTime = 1_240;
    const account = document.querySelector<HTMLInputElement>("input[name=identifier]")!;
    const password = document.querySelector<HTMLInputElement>("input[name=password]")!;
    account.focus();
    expect(root.hasAttribute("data-ambient-paused")).toBe(true);
    expect(root.hasAttribute("data-motion-paused")).toBe(false);
    expect(animation.pause).toHaveBeenCalled();
    password.focus();
    expect(animation.currentTime).toBe(1_240);
    document.querySelector<HTMLButtonElement>("main > button")!.focus();
    await Promise.resolve();
    expect(root.hasAttribute("data-ambient-paused")).toBe(false);
    expect(animation.play).toHaveBeenCalled();
    const button = root.shadowRoot!.querySelector<HTMLButtonElement>("[data-motion-toggle]")!;
    button.click();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(root.hasAttribute("data-motion-paused")).toBe(true);
    button.click();
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.hasAttribute("data-motion-paused")).toBe(true);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.hasAttribute("data-motion-paused")).toBe(false);
    expect(animation.currentTime).toBe(1_240);
    expect(flows).toHaveLength(4);
  });

  it("removes motion for reduced motion and releases effects and listeners on disposal", () => {
    const root = mount();
    reduced = true;
    finishIntro(root);
    expect(flows).toHaveLength(0);
    reduced = false;
    media.dispatchEvent(new Event("change"));
    expect(flows).toHaveLength(4);
    reduced = true;
    media.dispatchEvent(new Event("change"));
    expect(flows.every(({ animation }) => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(root.shadowRoot!.querySelectorAll(".flow-packet")).toHaveLength(0);
    cleanup!();
    cleanup = undefined;
    reduced = false;
    media.dispatchEvent(new Event("change"));
    root.shadowRoot!.querySelector<HTMLButtonElement>("[data-motion-toggle]")!.click();
    expect(flows).toHaveLength(4);
    expect(root.hasAttribute("data-motion-paused")).toBe(true);
  });
});
