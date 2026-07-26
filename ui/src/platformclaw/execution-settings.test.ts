import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountPlatformClawExecutionSettings } from "./execution-settings.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SETTINGS = {
  activeTarget: "platform_server",
  targetRevision: 3,
  credentialStatus: "current",
  assignment: {
    status: "ready",
    vmLabel: "Development VM",
    safeConnectLabel: "SafeConnect",
    linuxAccount: "person.one",
    remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
    lastConnectionSucceededAt: 1_700_000_000_000,
  },
};

describe("PlatformClaw execution settings", () => {
  afterEach(async () => {
    document.querySelector("platformclaw-execution-settings")?.remove();
    await i18n.setLocale("en");
  });

  it("renders the PlatformClaw overlay in Korean when Korean is selected", async () => {
    await i18n.setLocale("ko");
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SETTINGS));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-execution-settings")!;

    await vi.waitFor(() => {
      expect(element.shadowRoot?.textContent).toContain("기본 작업 공간");
    });
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();

    expect(element.shadowRoot?.textContent).toContain("현재 작업 위치");
    expect(element.shadowRoot?.textContent).toContain("할당된 개발 VM");
  });

  it("localizes a rejected AD password", async () => {
    await i18n.setLocale("ko");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(jsonResponse({ error: "AD password was not accepted" }, 422));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-execution-settings")!;
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("기본 작업 공간"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    const password = element.shadowRoot?.querySelector<HTMLInputElement>("[data-password]");
    if (password) {
      password.value = "wrong-password";
    }
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='credential']")?.click();

    await vi.waitFor(() => {
      expect(element.shadowRoot?.textContent).toContain("AD 비밀번호가 올바르지 않습니다.");
    });
  });

  it("keeps the current work location visible and explains the workspace boundary", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SETTINGS));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-execution-settings")!;

    await vi.waitFor(() => {
      expect(element.shadowRoot?.textContent).toContain("Basic workspace");
    });
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();

    expect(element.shadowRoot?.textContent).toContain(
      "Conversation and Agent settings stay. Files and processes do not move.",
    );
    expect(element.shadowRoot?.textContent).toContain("Development VM");
  });

  it("requires confirmation before changing to the assigned VM", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SETTINGS));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-execution-settings")!;
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Basic workspace"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    element.shadowRoot?.querySelector<HTMLElement>("[data-target='assigned_vm']")?.click();

    expect(element.shadowRoot?.textContent).toContain("Change work location?");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps an Escape-cancelled work-location dialog closed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SETTINGS));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-execution-settings")!;
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Basic workspace"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    const dialog = element.shadowRoot?.querySelector<HTMLDialogElement>("dialog.backdrop");

    dialog?.dispatchEvent(new Event("cancel", { cancelable: true }));

    expect(element.shadowRoot?.querySelector("dialog.backdrop")).toBeNull();
  });
});
