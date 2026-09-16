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

async function mount(
  options: { admin?: boolean; fetchImpl?: typeof fetch; vocEnabled?: boolean } = {},
) {
  const element = document.createElement(
    "platformclaw-quick-actions",
  ) as PlatformClawQuickActionsElement;
  element.admin = options.admin ?? false;
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps role-aware account actions without the retired Guide", async () => {
    const admin = await mount({ admin: true, vocEnabled: true });

    expect(admin.shadowRoot?.querySelector('[aria-label="Guide"]')).toBeNull();
    expect(admin.shadowRoot?.querySelector(".tour-popover")).toBeNull();
    expect(admin.shadowRoot?.querySelector("platformclaw-vm-administration")).not.toBeNull();
    const adminItems = [...(admin.shadowRoot?.querySelector(".grid")?.children ?? [])];
    expect(adminItems.map((item) => item.localName)).toEqual([
      "button",
      "button",
      "platformclaw-vm-administration",
    ]);

    admin.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="VOC"]')?.click();
    await admin.updateComplete;
    expect(admin.shadowRoot?.querySelector("platformclaw-voc-dialog")).not.toBeNull();
  });

  it("uses the PlatformClaw-owned Korean work-location copy", async () => {
    await i18n.setLocale("ko");
    await loadPlatformClawLocale();
    const member = await mount();

    await vi.waitFor(() => expect(member.shadowRoot?.textContent).toContain("기본 작업 공간"));
    expect(member.shadowRoot?.textContent).not.toContain("가이드");
  });

  it("opens the existing execution settings control", async () => {
    const member = await mount();
    member.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="work-location"]')?.click();

    await vi.waitFor(() =>
      expect(member.shadowRoot?.querySelector("platformclaw-execution-settings")).not.toBeNull(),
    );
  });
});
