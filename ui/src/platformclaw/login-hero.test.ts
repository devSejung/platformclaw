import { afterEach, describe, expect, it } from "vitest";
import { installPlatformClawLoginHero } from "./login-hero.ts";

describe("PlatformClaw login hero", () => {
  afterEach(() => document.body.replaceChildren());

  it("isolates the workspace illustration from upstream UI styles", () => {
    const root = document.createElement("section");
    document.body.append(root);

    installPlatformClawLoginHero(root);

    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.shadowRoot).not.toBeNull();
    expect(root.shadowRoot?.querySelector(".hero")).not.toBeNull();
    expect(root.shadowRoot?.querySelector("h1")?.textContent).toContain("완성된 업무로.");
    expect(root.shadowRoot?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 600 350");
    expect(root.shadowRoot?.querySelector("style")?.textContent).toMatch(/:host\s*\{/u);
  });
});
