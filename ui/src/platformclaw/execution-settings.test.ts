import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    document.querySelector("platformclaw-execution-settings")?.remove();
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
});
