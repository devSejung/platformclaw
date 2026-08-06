import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountPlatformClawExecutionSettings } from "./execution-settings.ts";
import { PLATFORMCLAW_EXECUTION_TARGET_CHANGED_EVENT } from "./execution-target-events.ts";

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
  accountId: "person.one",
  availableVms: [{ id: "vm-one", label: "Development VM" }],
  assignment: {
    vmHostId: "vm-one",
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
      expect(
        element.shadowRoot?.querySelector("[data-action='open']")?.getAttribute("aria-label"),
      ).toContain("실행 위치 준비됨");
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
    expect(
      element.shadowRoot?.querySelector("[data-action='open']")?.getAttribute("data-status"),
    ).toBe("ready");
    expect(element.shadowRoot?.textContent).toContain("Sandbox · Basic workspace");
  });

  it("shows a failed work-location check and retries from the same control", async () => {
    await i18n.setLocale("ko");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("Execution service unavailable"))
      .mockResolvedValueOnce(jsonResponse(SETTINGS));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-execution-settings")!;

    await vi.waitFor(() => {
      expect(element.shadowRoot?.textContent).toContain("작업 위치 확인 불가");
    });
    const badge = element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']");
    expect(badge?.getAttribute("data-status")).toBe("error");
    badge?.click();
    expect(element.shadowRoot?.querySelector("[role='alert']")?.textContent).toContain(
      "Execution service unavailable",
    );

    element.shadowRoot?.querySelector<HTMLElement>("[data-action='refresh']")?.click();

    await vi.waitFor(() => {
      expect(element.shadowRoot?.textContent).toContain("Sandbox · 기본 작업 공간");
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("marks an assigned VM that still needs credentials as actionable", async () => {
    await i18n.setLocale("ko");
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        ...SETTINGS,
        credentialStatus: "missing",
        assignment: { ...SETTINGS.assignment, status: "connection_required" },
      }),
    );
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-execution-settings")!;

    await vi.waitFor(() => {
      expect(
        element.shadowRoot?.querySelector("[data-action='open']")?.getAttribute("data-status"),
      ).toBe("attention");
    });
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    expect(element.shadowRoot?.textContent).toContain("VM 설정 필요");
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

  it("notifies open pages after the work location revision changes", async () => {
    const changedSettings = { ...SETTINGS, activeTarget: "assigned_vm", targetRevision: 4 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(jsonResponse(changedSettings));
    const listener = vi.fn();
    window.addEventListener(PLATFORMCLAW_EXECUTION_TARGET_CHANGED_EVENT, listener);
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-execution-settings")!;
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Basic workspace"));

    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    element.shadowRoot?.querySelector<HTMLElement>("[data-target='assigned_vm']")?.click();
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='confirm-switch']")?.click();

    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    window.removeEventListener(PLATFORMCLAW_EXECUTION_TARGET_CHANGED_EVENT, listener);
  });

  it("keeps an Escape-cancelled work-location dialog closed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SETTINGS));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-execution-settings")!;
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Basic workspace"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    const dialog = element.shadowRoot?.querySelector("openclaw-modal-dialog");

    dialog?.dispatchEvent(new Event("modal-cancel"));

    expect(element.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
