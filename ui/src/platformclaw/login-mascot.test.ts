import { afterEach, describe, expect, it, vi } from "vitest";
import { installPlatformClawLoginMascot } from "./login-mascot.ts";

const disposers: Array<() => void> = [];

function mount(...args: Parameters<typeof installPlatformClawLoginMascot>) {
  const dispose = installPlatformClawLoginMascot(...args);
  disposers.push(dispose);
  return dispose;
}

function fixture() {
  const root = document.createElement("div");
  const identifier = document.createElement("input");
  const secretInput = document.createElement("input");
  secretInput.type = "password";
  document.body.append(root, identifier, secretInput);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_000 });
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(434, 100, 132, 132));
  return { root, identifier, secretInput };
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

describe("PlatformClaw login mascot", () => {
  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts the canonical fixed-grid SVG", () => {
    const { root, identifier, secretInput } = fixture();
    const cleanup = mount(root, identifier, secretInput);
    const svg = root.querySelector("svg");

    expect(svg?.getAttribute("viewBox")).toBe("0 0 66 66");
    expect(svg?.getAttribute("shape-rendering")).toBe("crispEdges");
    expect(svg?.querySelector("#platformclaw")?.getAttribute("fill")).toBe("#0F7C72");
    expect(svg?.querySelectorAll("#eyes rect")).toHaveLength(2);

    cleanup();
    expect(root.childElementCount).toBe(0);
  });

  it("tracks pointer movement on the logical pixel grid while idle", async () => {
    const { root, identifier, secretInput } = fixture();
    mount(root, identifier, secretInput);

    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 900, clientY: 80 }));
    await nextAnimationFrame();

    const bodyX = Number.parseInt(root.style.getPropertyValue("--mascot-x"), 10);
    expect(bodyX).toBeGreaterThan(0);
    expect(bodyX % 2).toBe(0);
    expect(root.style.getPropertyValue("--eye-x")).toBe("3px");
    expect(root.dataset.loginMascotMode).toBe("idle");
  });

  it("follows account input and hides its eyes for password entry", async () => {
    const { root, identifier, secretInput } = fixture();
    mount(root, identifier, secretInput);
    vi.spyOn(identifier, "getBoundingClientRect").mockReturnValue(new DOMRect(600, 300, 240, 44));

    identifier.focus();
    identifier.value = "person.one";
    identifier.setSelectionRange(identifier.value.length, identifier.value.length);
    identifier.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await nextAnimationFrame();

    expect(root.dataset.loginMascotMode).toBe("account");
    expect(Number.parseInt(root.style.getPropertyValue("--mascot-x"), 10)).toBeGreaterThan(0);

    secretInput.focus();
    expect(root.dataset.loginMascotMode).toBe("password");
    expect(root.style.getPropertyValue("--eye-open")).toBe("0.25");
    expect(root.style.getPropertyValue("--eye-x")).toBe("0px");
  });

  it("keeps a still pose with reduced motion while preserving password privacy", async () => {
    const media = new EventTarget();
    vi.stubGlobal("matchMedia", () => Object.assign(media, { matches: true }));
    const { root, identifier, secretInput } = fixture();
    const cleanup = mount(root, identifier, secretInput);

    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 900, clientY: 80 }));
    identifier.focus();
    await nextAnimationFrame();

    expect(root.style.getPropertyValue("--mascot-x")).toBe("0px");
    expect(root.style.getPropertyValue("--eye-x")).toBe("0px");
    expect(root.classList.contains("is-blinking")).toBe(false);
    secretInput.focus();
    expect(root.dataset.loginMascotMode).toBe("password");
    expect(root.style.getPropertyValue("--eye-open")).toBe("0.25");
    cleanup();
  });

  it.each(["identifier", "secretInput"] as const)(
    "keeps %s focus authoritative over a queued idle pointer frame",
    async (inputName) => {
      const elements = fixture();
      mount(elements.root, elements.identifier, elements.secretInput);
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 900, clientY: 80 }));
      elements[inputName].focus();
      await nextAnimationFrame();

      const password = inputName === "secretInput";
      expect(elements.root.dataset.loginMascotMode).toBe(password ? "password" : "account");
      expect(elements.root.style.getPropertyValue("--eye-open")).toBe(password ? "0.25" : "1");
    },
  );

  it.each(["pointerleave", "resize"])("cancels pending pointer work on %s", async (eventName) => {
    const { root, identifier, secretInput } = fixture();
    mount(root, identifier, secretInput);
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 900, clientY: 80 }));
    (eventName === "resize" ? window : document).dispatchEvent(new Event(eventName));
    await nextAnimationFrame();

    expect(root.style.getPropertyValue("--mascot-x")).toBe("0px");
    expect(root.style.getPropertyValue("--eye-x")).toBe("0px");
    expect(root.querySelector(".is-waddling")).toBeNull();
  });

  it("blinks while idle and keeps its eyes masked during password entry", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { root, identifier, secretInput } = fixture();
    mount(root, identifier, secretInput);

    await vi.advanceTimersByTimeAsync(2_800);
    expect(root.classList.contains("is-blinking")).toBe(true);
    await vi.advanceTimersByTimeAsync(140);
    expect(root.classList.contains("is-blinking")).toBe(false);
    secretInput.focus();
    await vi.advanceTimersByTimeAsync(2_800);
    expect(root.classList.contains("is-blinking")).toBe(false);
    expect(root.style.getPropertyValue("--eye-open")).toBe("0.25");
  });
});
