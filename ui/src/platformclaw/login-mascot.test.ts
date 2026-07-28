import { afterEach, describe, expect, it, vi } from "vitest";
import { installPlatformClawLoginMascot } from "./login-mascot.ts";

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

describe("PlatformClaw login mascot", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("mounts the canonical fixed-grid SVG", () => {
    const { root, identifier, secretInput } = fixture();
    const cleanup = installPlatformClawLoginMascot(root, identifier, secretInput);
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
    installPlatformClawLoginMascot(root, identifier, secretInput);

    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 900, clientY: 80 }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    const bodyX = Number.parseInt(root.style.getPropertyValue("--mascot-x"), 10);
    expect(bodyX).toBeGreaterThan(0);
    expect(bodyX % 2).toBe(0);
    expect(root.style.getPropertyValue("--eye-x")).toBe("3px");
    expect(root.dataset.loginMascotMode).toBe("idle");
  });

  it("follows account input and hides its eyes for password entry", async () => {
    const { root, identifier, secretInput } = fixture();
    installPlatformClawLoginMascot(root, identifier, secretInput);
    vi.spyOn(identifier, "getBoundingClientRect").mockReturnValue(new DOMRect(600, 300, 240, 44));

    identifier.focus();
    identifier.value = "person.one";
    identifier.setSelectionRange(identifier.value.length, identifier.value.length);
    identifier.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    expect(root.dataset.loginMascotMode).toBe("account");
    expect(Number.parseInt(root.style.getPropertyValue("--mascot-x"), 10)).toBeGreaterThan(0);

    secretInput.focus();
    expect(root.dataset.loginMascotMode).toBe("password");
    expect(root.style.getPropertyValue("--eye-open")).toBe("0.25");
    expect(root.style.getPropertyValue("--eye-x")).toBe("0px");
  });
});
