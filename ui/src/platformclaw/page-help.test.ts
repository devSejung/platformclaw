import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import { pageHelpForRoute, PlatformClawPageHelpElement } from "./page-help.ts";

describe("PlatformClaw page help", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
    await loadPlatformClawLocale();
  });

  it("keeps the trigger beside the exact heading and the modal outside route content", async () => {
    const heading = document.createElement("h1");
    heading.className = "page-title";
    heading.textContent = "Dashboard";
    const query = document.createElement("input");
    query.className = "usage-query-input";
    const trigger = document.createElement("platformclaw-page-help-trigger");
    trigger.routeId = "usage";
    const element = document.createElement("platformclaw-page-help") as PlatformClawPageHelpElement;
    element.routeId = "usage";
    document.body.append(heading, trigger, query, element);
    await trigger.updateComplete;
    await element.updateComplete;

    expect(heading.textContent).toBe("Dashboard");
    expect(heading.nextElementSibling).toBe(trigger);
    expect(trigger.nextElementSibling).toBe(query);
    expect(query.isConnected).toBe(true);
    expect(element.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
    const button = trigger.shadowRoot?.querySelector<HTMLButtonElement>("button");
    expect(button?.ariaLabel).toBe("Help for Dashboard: understand platform activity");
    button?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector(".help-panel h2")?.textContent).toBe(
      "Dashboard: understand platform activity",
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
    ["/settings/memory", "Memory: search personal recall"],
    ["/settings/memory/memories", "Memory: search personal recall"],
    ["/settings/memory/wiki", "Wiki Hub: personal and shared knowledge"],
    ["/settings/memory/organization", "Wiki Hub: personal and shared knowledge"],
    ["/settings/memory/dreams", "Dreaming: inspect memory consolidation"],
  ])("selects Memory help from %s", (pathname, title) => {
    expect(pageHelpForRoute("memory", pathname).title).toBe(title);
  });

  it.each(["en", "ko"] as const)("uses Space copy rather than Settings in %s", async (locale) => {
    await i18n.setLocale(locale);
    await loadPlatformClawLocale();
    expect(pageHelpForRoute("spaces")).toEqual({
      title: "Spaces",
      body:
        locale === "ko"
          ? "공유 페이지에서 내 에이전트와 대화합니다. Space 에이전트는 공용 질문과 최종 답변을 참고할 수 있습니다."
          : "Shared pages and your own agent conversations. Space agents can recall shared questions and final answers.",
      details: [],
    });
  });

  it.each(["en", "ko"] as const)("uses product Credentials copy in %s", async (locale) => {
    await i18n.setLocale(locale);
    await loadPlatformClawLocale();
    expect(pageHelpForRoute("credentials")).toEqual({
      title: "Credentials",
      body:
        locale === "ko"
          ? "저장한 값은 내 개인 Agent의 모든 Basic·VM exec에 환경변수로 전달됩니다. 값은 다시 표시되지 않습니다."
          : "Saved values are injected as environment variables into every Basic and VM exec for your personal Agent. Values are never shown again.",
      details: [],
    });
  });

  it("refreshes the Space trigger and open help through Korean-English-Korean changes", async () => {
    const trigger = document.createElement("platformclaw-page-help-trigger");
    trigger.routeId = "spaces";
    const element = document.createElement("platformclaw-page-help");
    element.routeId = "spaces";
    document.body.append(trigger, element);
    await trigger.updateComplete;
    trigger.shadowRoot?.querySelector("button")?.click();
    for (const locale of ["ko", "en", "ko"] as const) {
      await i18n.setLocale(locale);
      await loadPlatformClawLocale();
      await trigger.updateComplete;
      await element.updateComplete;
      const label = locale === "ko" ? "Spaces 도움말" : "Help for Spaces";
      const button = trigger.shadowRoot?.querySelector("button");
      expect(button?.ariaLabel).toBe(label);
      expect(button?.title).toBe(label);
      expect(element.shadowRoot?.querySelector(".help-panel p")?.textContent).toBe(
        pageHelpForRoute("spaces").body,
      );
    }
  });

  it.each(["en", "ko"] as const)(
    "uses the Profile title and matching subtitle in %s",
    async (locale) => {
      await i18n.setLocale(locale);
      await loadPlatformClawLocale();
      expect(pageHelpForRoute("profile")).toEqual({
        title: locale === "ko" ? "프로필" : "Profile",
        body:
          locale === "ko"
            ? "이 Gateway에서 사용하는 내 표시 이름, 아바타, 신원 정보입니다."
            : "Your display name, avatar, and identity on this gateway.",
        details: [],
      });
    },
  );

  it.each([
    ["/settings/plugins", "Installed: manage active plugins"],
    ["/settings/plugins/discover", "Discover: add new capabilities"],
  ])("selects Plugins help from %s", (pathname, title) => {
    expect(pageHelpForRoute("plugins", pathname).title).toBe(title);
  });
});
