import { afterEach, describe, expect, it, vi } from "vitest";
import "./mcp-page.ts";

type McpPageElement = HTMLElement & {
  admin: boolean;
  fetchImpl: typeof fetch;
  updateComplete: Promise<boolean>;
};

afterEach(() =>
  document.querySelectorAll("platformclaw-mcp-page").forEach((element) => element.remove()),
);

describe("PlatformClaw MCP role views", () => {
  it("moves keyboard focus and active panels with Arrow, Home, and End while retaining child views", async () => {
    const page = document.createElement("platformclaw-mcp-page") as McpPageElement;
    page.admin = true;
    page.fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ servers: [] })));
    document.body.append(page);
    await page.updateComplete;
    const settings = page.querySelector("platformclaw-mcp-settings");
    const administration = page.querySelector("platformclaw-mcp-administration");
    for (const [key, expected] of [
      ["ArrowRight", "settings"],
      ["ArrowRight", "administration"],
      ["End", "settings"],
      ["Home", "administration"],
      ["ArrowLeft", "settings"],
    ]) {
      page
        .querySelector<HTMLElement>("[role='tab'][aria-selected='true']")!
        .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await page.updateComplete;
      const tab = page.querySelector<HTMLElement>(`#mcp-tab-${expected}`)!;
      expect(tab.getAttribute("aria-selected")).toBe("true");
      expect(tab.tabIndex).toBe(0);
      expect(document.activeElement).toBe(tab);
      expect(page.querySelector(`#mcp-panel-${expected}`)?.hasAttribute("hidden")).toBe(false);
    }
    expect(page.querySelector("platformclaw-mcp-settings")).toBe(settings);
    expect(page.querySelector("platformclaw-mcp-administration")).toBe(administration);
  });
  it("keeps administrators' own settings mounted while switching between the two tabs", async () => {
    const page = document.createElement("platformclaw-mcp-page") as McpPageElement;
    page.admin = true;
    page.fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ servers: [] }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    document.body.append(page);
    await page.updateComplete;
    const settings = page.querySelector("platformclaw-mcp-settings");
    expect(settings).not.toBeNull();
    expect(page.querySelector("#mcp-panel-settings")?.hasAttribute("hidden")).toBe(true);
    page.querySelector<HTMLButtonElement>("#mcp-tab-settings")!.click();
    await page.updateComplete;
    expect(page.querySelector("#mcp-panel-settings")?.hasAttribute("hidden")).toBe(false);
    expect(page.querySelector("#mcp-panel-administration")?.hasAttribute("hidden")).toBe(true);
    page.querySelector<HTMLButtonElement>("#mcp-tab-administration")!.click();
    await page.updateComplete;
    expect(page.querySelector("platformclaw-mcp-settings")).toBe(settings);
  });
  it("exposes only personal settings to members and no personal-server creation controls", async () => {
    const page = document.createElement("platformclaw-mcp-page") as McpPageElement;
    page.fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ servers: [] }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    document.body.append(page);
    await page.updateComplete;
    expect(page.querySelector("[role='tablist']")).toBeNull();
    expect(page.querySelector("platformclaw-mcp-administration")).toBeNull();
    expect(page.querySelector("platformclaw-mcp-settings")).not.toBeNull();
    expect(page.querySelector("#mcp-panel-settings")?.hasAttribute("hidden")).toBe(false);
  });
});
