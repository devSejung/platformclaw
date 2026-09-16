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

  it("keeps the trigger beside the exact heading and the modal outside route content", async () => {
    const heading = document.createElement("h1");
    heading.className = "page-title";
    heading.textContent = "Usage";
    const query = document.createElement("input");
    query.className = "usage-query-input";
    const trigger = document.createElement("platformclaw-page-help-trigger");
    trigger.routeId = "usage";
    const element = document.createElement("platformclaw-page-help") as PlatformClawPageHelpElement;
    element.routeId = "usage";
    document.body.append(heading, trigger, query, element);
    await trigger.updateComplete;
    await element.updateComplete;

    expect(heading.textContent).toBe("Usage");
    expect(heading.nextElementSibling).toBe(trigger);
    expect(trigger.nextElementSibling).toBe(query);
    expect(query.isConnected).toBe(true);
    expect(element.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
    const button = trigger.shadowRoot?.querySelector<HTMLButtonElement>("button");
    expect(button?.ariaLabel).toBe("Help for Usage: understand tokens and cost");
    button?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector(".help-panel h2")?.textContent).toBe(
      "Usage: understand tokens and cost",
    );
    expect(element.shadowRoot?.querySelector(".tour-progress")).toBeNull();
    expect(element.shadowRoot?.querySelector(".tour-highlight")).toBeNull();
    element.shadowRoot?.querySelector<HTMLButtonElement>(".help-close")?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(query.isConnected).toBe(true);
    button?.click();
    await element.updateComplete;
    element.routeId = "tasks";
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(query.isConnected).toBe(true);
  });

  it("refreshes localized trigger copy after the locale changes", async () => {
    const trigger = document.createElement("platformclaw-page-help-trigger");
    trigger.routeId = "chat";
    document.body.append(trigger);
    await trigger.updateComplete;
    expect(trigger.shadowRoot?.querySelector("button")?.ariaLabel).toBe(
      "Help for Home: start a conversation with your Agent",
    );

    await i18n.setLocale("ko");
    await loadPlatformClawLocale();
    await trigger.updateComplete;
    expect(trigger.shadowRoot?.querySelector("button")?.ariaLabel).not.toContain(
      "platformClaw.guide",
    );
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
