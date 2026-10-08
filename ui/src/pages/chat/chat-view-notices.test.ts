import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderChatRunErrorNotice } from "./chat-view-notices.ts";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  render(nothing, document.body);
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  vi.restoreAllMocks();
});

describe("chat run error recovery", () => {
  it("shows the first line and keeps multiline diagnostics expandable and copyable", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const error =
      "Your message didn't run because the conversation changed. Refresh the conversation, then send it again.\n\nDispatchSessionRefreshRequiredError: session-1 changed\n  at dispatch()";
    const onRefresh = vi.fn();
    render(
      renderChatRunErrorNotice({ runError: { summary: error }, connected: true, onRefresh }),
      document.body,
    );
    const details = document.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("strong")?.textContent).toBe(error.split("\n")[0]);
    expect(document.querySelector(".chat-run-error__diagnostic")?.textContent).toBe(error);
    details.open = true;
    expect(details.querySelector("pre")?.getAttribute("tabindex")).toBe("0");
    document.querySelector<HTMLButtonElement>('[aria-label="Copy error"]')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(error));
    document.querySelector<HTMLButtonElement>(".chat-run-error__refresh")!.click();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("retains full long-line errors while bounding the visible summary", () => {
    const error = `Request failed: ${"diagnostic ".repeat(80)}`;
    render(
      renderChatRunErrorNotice({
        runError: { summary: error },
        connected: false,
        onRefresh: vi.fn(),
      }),
      document.body,
    );
    expect(document.querySelector("strong")!.textContent!.length).toBeLessThan(error.length);
    expect(document.querySelector("pre")?.textContent).toBe(error);
    expect(document.querySelector<HTMLButtonElement>(".chat-run-error__refresh")?.disabled).toBe(
      true,
    );
  });

  it("keeps a short error visible without requiring disclosure", () => {
    render(
      renderChatRunErrorNotice({ runError: { summary: "Gateway disconnected" }, connected: true }),
      document.body,
    );
    expect(document.querySelector("details")).toBeNull();
    expect(document.querySelector(".chat-run-error__summary")?.textContent).toBe(
      "Gateway disconnected",
    );
    expect(document.querySelector('[aria-label="Copy error"]')).not.toBeNull();
    expect(document.querySelector(".chat-run-error__refresh")).toBeNull();
  });
});
