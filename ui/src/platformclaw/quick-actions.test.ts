import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import { PlatformClawQuickActionsElement } from "./quick-actions.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

const BASIC_EXECUTION_SETTINGS = {
  activeTarget: "platform_server",
  targetRevision: 4,
  credentialStatus: "current",
  accountId: "person.one",
  availableVms: [],
};

async function mount(options: { fetchImpl?: typeof fetch; vocEnabled?: boolean } = {}) {
  const element = document.createElement(
    "platformclaw-quick-actions",
  ) as PlatformClawQuickActionsElement;
  element.fetchImpl =
    options.fetchImpl ?? vi.fn<typeof fetch>(async () => jsonResponse(BASIC_EXECUTION_SETTINGS));
  element.vocEnabled = options.vocEnabled ?? false;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe("platformclaw-quick-actions", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
    await loadPlatformClawLocale();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("shares the VOC row with the messenger link above personal work-location", async () => {
    const element = await mount({ vocEnabled: true });

    expect(element.shadowRoot?.querySelector('[aria-label="Guide"]')).toBeNull();
    expect(element.shadowRoot?.querySelector(".tour-popover")).toBeNull();
    expect(element.shadowRoot?.querySelector("platformclaw-vm-administration")).toBeNull();
    expect(
      element.shadowRoot?.querySelector("platformclaw-announcement-administration"),
    ).toBeNull();
    const items = [...(element.shadowRoot?.querySelector(".grid")?.children ?? [])];
    expect(items.map((item) => item.localName)).toEqual(["button", "a", "button"]);
    const messenger = element.shadowRoot?.querySelector<HTMLAnchorElement>("a.messenger");
    expect(messenger?.getAttribute("href")).toBe("mysingleim://sopa.ai");
    expect(messenger?.getAttribute("aria-label")).toBe("Knox");
    expect(messenger?.classList.contains("messenger--split")).toBe(true);

    element.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="VOC"]')?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("platformclaw-voc-dialog")).not.toBeNull();
  });

  it("uses the PlatformClaw-owned Korean work-location copy", async () => {
    await i18n.setLocale("ko");
    await loadPlatformClawLocale();
    const member = await mount();

    await vi.waitFor(() => expect(member.shadowRoot?.textContent).toContain("기본 서버"));
    expect(member.shadowRoot?.textContent).not.toContain("가이드");
    const messenger = member.shadowRoot?.querySelector<HTMLAnchorElement>("a.messenger");
    expect(messenger?.getAttribute("aria-label")).toBe("Knox");
    expect(messenger?.classList.contains("span-two")).toBe(true);
  });

  it("opens the existing execution settings control", async () => {
    const member = await mount();
    member.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="work-location"]')?.click();

    await vi.waitFor(() =>
      expect(member.shadowRoot?.querySelector("platformclaw-execution-settings")).not.toBeNull(),
    );
  });
});
