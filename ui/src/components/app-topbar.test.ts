/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import "./app-topbar.ts";

type TestTopbar = HTMLElement & {
  brandIconUrl: string;
  brandName: string;
  updateComplete: Promise<boolean>;
};

describe("app topbar branding", () => {
  afterEach(() => document.body.replaceChildren());

  it("keeps OpenClaw as the default product", async () => {
    const topbar = document.createElement("openclaw-app-topbar") as TestTopbar;
    document.body.append(topbar);
    await topbar.updateComplete;

    expect(topbar.querySelector(".topbar-brand")?.getAttribute("aria-label")).toBe("OpenClaw");
    expect(topbar.querySelector(".topbar-brand__title")?.textContent).toBe("OpenClaw");
  });

  it("renders the authenticated embedder brand and asset", async () => {
    const topbar = document.createElement("openclaw-app-topbar") as TestTopbar;
    topbar.brandName = "PlatformClaw";
    topbar.brandIconUrl = "/assets/platformclaw.svg";
    document.body.append(topbar);
    await topbar.updateComplete;

    expect(topbar.querySelector(".topbar-brand")?.getAttribute("aria-label")).toBe("PlatformClaw");
    expect(topbar.querySelector(".topbar-brand__title")?.textContent).toBe("PlatformClaw");
    expect(topbar.querySelector("img")?.getAttribute("src")).toBe("/assets/platformclaw.svg");
  });
});
