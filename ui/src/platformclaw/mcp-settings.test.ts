import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountPlatformClawMcpSettings } from "./mcp-settings.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SETTINGS = {
  servers: [
    { serverName: "docs", auth: "api_key", headerName: "X-Api-Key", configured: false },
    { serverName: "github", auth: "oauth", scope: "repo:read", configured: true, revision: 2 },
  ],
};

function mountedElement(): HTMLElement {
  return [...document.querySelectorAll<HTMLElement>("platformclaw-mcp-settings")].at(-1)!;
}

describe("PlatformClaw MCP settings", () => {
  afterEach(async () => {
    for (const element of document.querySelectorAll("platformclaw-mcp-settings")) {
      element.remove();
    }
    window.history.replaceState(null, "", "/");
    await i18n.setLocale("en");
  });

  it("shows only the administrator-projected personal MCP catalog", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SETTINGS));
    mountPlatformClawMcpSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = mountedElement();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("MCP connections"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();

    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("github"));
    expect(element.shadowRoot?.textContent).toContain("docs");
    expect(element.shadowRoot?.textContent).toContain("Scope: repo:read");
    expect(element.shadowRoot?.querySelector("[data-action='close']")?.textContent).toBe("×");
    expect(element.shadowRoot?.textContent).not.toContain("Add server");
  });

  it("explains empty credential submissions instead of silently ignoring them", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SETTINGS));
    mountPlatformClawMcpSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = mountedElement();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("MCP connections"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("docs"));
    element.shadowRoot
      ?.querySelector<HTMLElement>("[data-action='save'][data-server='docs']")
      ?.click();

    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain(
        "Enter credentials for docs before saving.",
      ),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends only server name, approved kind, and secret for API-key replacement", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(jsonResponse({ serverName: "docs", revision: 1 }))
      .mockResolvedValueOnce(jsonResponse(SETTINGS));
    mountPlatformClawMcpSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = mountedElement();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("MCP connections"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("docs"));
    const secret = element.shadowRoot?.querySelector<HTMLInputElement>("[data-secret='docs']");
    if (secret) {
      secret.value = "employee-secret";
      secret.dispatchEvent(new Event("input"));
    }
    element.shadowRoot
      ?.querySelector<HTMLElement>("[data-action='save'][data-server='docs']")
      ?.click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ serverName: "docs", kind: "api_key", secret: "employee-secret" }),
    });
  });

  it("keeps a secret draft available when saving fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(jsonResponse({ error: "Gateway unavailable" }, 503));
    mountPlatformClawMcpSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = mountedElement();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("MCP connections"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("docs"));
    const secret = element.shadowRoot?.querySelector<HTMLInputElement>("[data-secret='docs']");
    if (secret) {
      secret.value = "one-time-secret";
      secret.dispatchEvent(new Event("input"));
    }
    element.shadowRoot
      ?.querySelector<HTMLElement>("[data-action='save'][data-server='docs']")
      ?.click();

    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain("Gateway unavailable"),
    );
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[data-secret='docs']")?.value).toBe(
      "one-time-secret",
    );
  });

  it("keeps idempotent removal available after stored state is already absent", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        servers: [{ serverName: "docs", auth: "api_key", configured: false }],
      }),
    );
    mountPlatformClawMcpSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = mountedElement();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("MCP connections"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();

    await vi.waitFor(() =>
      expect(
        element.shadowRoot?.querySelector("[data-action='remove'][data-server='docs']"),
      ).not.toBeNull(),
    );
  });

  it("navigates only to the OAuth authorization URL returned by Control", async () => {
    const navigate = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(
        jsonResponse({ status: "redirect", authorizationUrl: "https://auth.example.test/start" }),
      );
    mountPlatformClawMcpSettings({ fetchImpl, onUnauthenticated: vi.fn(), navigate });
    const element = mountedElement();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("MCP connections"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("github"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='oauth']")?.click();

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("https://auth.example.test/start"),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("opens the settings and reports an OAuth callback result once", async () => {
    window.history.replaceState(null, "", "/platformclaw/app/chat?mcpOAuth=success");
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SETTINGS));
    mountPlatformClawMcpSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = mountedElement();

    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain("OAuth connection completed."),
    );
    expect(element.shadowRoot?.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(window.location.search).toBe("");
  });

  it("rejects a non-HTTP OAuth authorization URL", async () => {
    const navigate = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(
        jsonResponse({ status: "redirect", authorizationUrl: "javascript:alert(1)" }),
      );
    mountPlatformClawMcpSettings({ fetchImpl, onUnauthenticated: vi.fn(), navigate });
    const element = mountedElement();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("MCP connections"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("github"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='oauth']")?.click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(navigate).not.toHaveBeenCalled();
  });
});
