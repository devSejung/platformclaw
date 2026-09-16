import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import { pageHelpForRoute, PlatformClawPageHelpElement } from "./page-help.ts";

describe("PlatformClaw page help", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
    await loadPlatformClawLocale();
  });

  it("uses the current route's guide without navigation controls", async () => {
    const element = document.createElement("platformclaw-page-help") as PlatformClawPageHelpElement;
    element.routeId = "usage";
    document.body.append(element);
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector<HTMLButtonElement>(".help-button")?.ariaLabel).toBe(
      "Help for Usage: understand tokens and cost",
    );
    element.shadowRoot?.querySelector<HTMLButtonElement>(".help-button")?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector(".help-panel h2")?.textContent).toBe(
      "Usage: understand tokens and cost",
    );
    expect(element.shadowRoot?.querySelector(".tour-progress")).toBeNull();
    expect(element.shadowRoot?.querySelector(".tour-highlight")).toBeNull();
  });

  it.each([
    ["/settings/memory", "Memory: five views for retained knowledge"],
    ["/settings/memory/memories", "Memory: search personal recall"],
    ["/settings/memory/wiki", "Personal Wiki: review reusable source pages"],
    ["/settings/memory/organization", "Organization: promote personal knowledge to your Part"],
    ["/settings/memory/dreams", "Dreaming: inspect memory consolidation"],
  ])("selects Memory help from %s", (pathname, title) => {
    expect(pageHelpForRoute("memory", pathname).title).toBe(title);
  });

  it("falls back to the route title and subtitle for tabs without tour copy", () => {
    expect(pageHelpForRoute("profile")).toEqual({
      title: "Profile",
      body: "Your display name, avatar, and identity on this gateway.",
      details: [],
    });
  });

  it.each([
    ["/settings/plugins", "Installed: manage active plugins"],
    ["/settings/plugins/discover", "Discover: add new capabilities"],
  ])("selects Plugins help from %s", (pathname, title) => {
    expect(pageHelpForRoute("plugins", pathname).title).toBe(title);
  });
});
