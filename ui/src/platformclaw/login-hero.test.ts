import { afterEach, describe, expect, it } from "vitest";
import { installPlatformClawLoginHero } from "./login-hero.ts";

describe("PlatformClaw login hero", () => {
  afterEach(() => document.body.replaceChildren());

  it("isolates the supplied workflow preview from upstream UI styles", () => {
    const root = document.createElement("section");
    document.body.append(root);

    installPlatformClawLoginHero(root);

    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.shadowRoot).not.toBeNull();
    expect(root.shadowRoot?.querySelector(".hero")).not.toBeNull();
    expect(root.shadowRoot?.textContent).toContain("Issue → Docs → Build → Board → Report");
    expect(root.shadowRoot?.textContent).toContain("Rev.B Boot Validation");
    expect(root.shadowRoot?.querySelector("style")?.textContent).toContain(":host{");
  });
});
