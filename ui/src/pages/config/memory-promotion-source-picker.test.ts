/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { PersonalWikiSourceSelected } from "./memory-promotion-source-picker.ts";
import "./memory-promotion-source-picker.ts";

type SourcePickerTestElement = HTMLElement & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  searchAdvertised: boolean;
  getAdvertised: boolean;
  agentId: string | null;
  updateComplete: Promise<unknown>;
};

describe("MemoryPromotionSourcePickerElement", () => {
  it("shows a useful unavailable state and disables search when Wiki RPCs are hidden", async () => {
    const request = vi.fn();
    const element = document.createElement(
      "openclaw-memory-promotion-source-picker",
    ) as SourcePickerTestElement;
    element.client = { request } as unknown as GatewayBrowserClient;
    element.connected = true;
    element.agentId = "personal-agent";
    document.body.append(element);
    await element.updateComplete;

    expect(element.querySelector('[role="status"]')?.textContent).toContain(
      "Personal Wiki search is unavailable",
    );
    expect(element.querySelector<HTMLButtonElement>("form button")?.disabled).toBe(true);
    expect(request).not.toHaveBeenCalled();
    element.remove();
  });

  it("searches and previews the selected Agent-pinned personal Wiki page", async () => {
    const request = vi.fn(async (method: string) =>
      method === "wiki.search"
        ? [
            {
              path: "runbooks/recovery.md",
              title: "Recovery",
              snippet: "Drain jobs before restart",
            },
          ]
        : {
            path: "runbooks/recovery.md",
            title: "Recovery",
            content: "# Recovery\nDrain jobs before restart",
          },
    );
    const element = document.createElement(
      "openclaw-memory-promotion-source-picker",
    ) as SourcePickerTestElement;
    element.client = { request } as unknown as GatewayBrowserClient;
    element.connected = true;
    element.searchAdvertised = true;
    element.getAdvertised = true;
    element.agentId = "personal-agent";
    document.body.append(element);
    await element.updateComplete;

    const input = element.querySelector<HTMLInputElement>("input")!;
    input.value = "recovery";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    element.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true }));
    await waitForFast(() => expect(element.textContent).toContain("Recovery"));
    expect(request).toHaveBeenCalledWith("wiki.search", {
      agentId: "personal-agent",
      query: "recovery",
      maxResults: 20,
    });

    let selected: PersonalWikiSourceSelected | null = null;
    element.addEventListener("source-selected", (event) => {
      selected = (event as CustomEvent<PersonalWikiSourceSelected>).detail;
    });
    element.querySelector<HTMLButtonElement>(".memory-source-picker__result")!.click();
    await waitForFast(() => expect(selected).not.toBeNull());
    expect(request).toHaveBeenLastCalledWith("wiki.get", {
      agentId: "personal-agent",
      lookup: "runbooks/recovery.md",
      fromLine: 1,
      lineCount: 5_000,
    });
    expect(selected).toEqual({
      lookup: "runbooks/recovery.md",
      title: "Recovery",
      content: "# Recovery\nDrain jobs before restart",
      path: "runbooks/recovery.md",
    });
    expect(element.querySelector("pre")?.textContent).toContain("Drain jobs before restart");
    element.remove();
  });

  it("rejects a truncated page instead of submitting incomplete knowledge", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce([{ path: "large.md", title: "Large", snippet: "Large knowledge" }])
      .mockResolvedValueOnce({
        path: "large.md",
        title: "Large",
        content: "partial",
        truncated: true,
      });
    const element = document.createElement(
      "openclaw-memory-promotion-source-picker",
    ) as SourcePickerTestElement;
    element.client = { request } as unknown as GatewayBrowserClient;
    element.connected = true;
    element.searchAdvertised = true;
    element.getAdvertised = true;
    element.agentId = "personal-agent";
    document.body.append(element);
    await element.updateComplete;
    const input = element.querySelector<HTMLInputElement>("input")!;
    input.value = "large";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    element.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true }));
    await waitForFast(() => expect(element.textContent).toContain("Large"));
    element.querySelector<HTMLButtonElement>(".memory-source-picker__result")!.click();
    await waitForFast(() => expect(element.querySelector("[role=alert]")).not.toBeNull());
    expect(element.querySelector("pre")).toBeNull();
    element.remove();
  });

  it("discards a search response from the previously assigned Agent", async () => {
    let resolveSearch: ((value: unknown) => void) | undefined;
    const request = vi.fn(
      async () =>
        await new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const element = document.createElement(
      "openclaw-memory-promotion-source-picker",
    ) as SourcePickerTestElement;
    element.client = { request } as unknown as GatewayBrowserClient;
    element.connected = true;
    element.searchAdvertised = true;
    element.getAdvertised = true;
    element.agentId = "old-agent";
    document.body.append(element);
    await element.updateComplete;

    const input = element.querySelector<HTMLInputElement>("input")!;
    input.value = "old knowledge";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    element.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true }));
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    element.agentId = "new-agent";
    await element.updateComplete;
    resolveSearch?.([{ path: "old.md", title: "Old result", snippet: "stale" }]);
    await Promise.resolve();
    await element.updateComplete;

    expect(element.textContent).not.toContain("Old result");
    expect(element.querySelector<HTMLInputElement>("input")?.value).toBe("");
    element.remove();
  });
});
