import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { renderChatRunErrorNotice } from "./chat-view-notices.ts";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  // Lit retains marker ownership on its container across the shared test DOM.
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  container.remove();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("chat run error recovery", () => {
  it("copies the safe support report with visible confirmation and keeps details collapsed", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const error =
      "The agent connection closed before a response could be completed. Some actions may already have completed. Check their results before trying again.\nReference ID: run-1";
    const report =
      "OpenClaw error report\nReference ID: run-1\nCode: EPIPE\nTime: 2026-10-22T08:00:00.000Z";
    const onRefresh = vi.fn();
    render(
      renderChatRunErrorNotice({
        runError: { summary: error, details: report },
        connected: true,
        onRefresh,
      }),
      container,
    );
    const details = container.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open).toBe(false);
    expect(container.querySelector("strong")?.textContent).toBe(error.split("\n")[0]);
    const button = container.querySelector<HTMLButtonElement>(
      `[aria-label="${t("chat.copyError")}"]`,
    )!;
    expect(button.textContent).toContain(t("chat.copyError"));
    button.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(report);
      expect(container.querySelector("[role='status']")?.textContent).toBe(t("chat.errorCopied"));
    });
    expect(button.textContent).toContain(t("common.copied"));
    expect(details.open).toBe(false);
    container.querySelector<HTMLButtonElement>(".chat-run-error__refresh")!.click();
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
      container,
    );
    expect(container.querySelector("strong")!.textContent!.length).toBeLessThan(error.length);
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(error);
    expect(container.querySelector<HTMLButtonElement>(".chat-run-error__refresh")?.disabled).toBe(
      true,
    );
  });

  it("keeps a short error visible and its report selectable when both clipboard APIs fail", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("permission denied");
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      renderChatRunErrorNotice({ runError: { summary: "Gateway disconnected" }, connected: true }),
      container,
    );
    const details = container.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open).toBe(false);
    expect(container.querySelector(".chat-run-error__summary")?.textContent).toBe(
      "Gateway disconnected",
    );
    expect(container.querySelector(`[aria-label="${t("chat.copyError")}"]`)).not.toBeNull();
    expect(container.querySelector(".chat-run-error__refresh")).toBeNull();
    container.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(details.open).toBe(true));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.readOnly).toBe(true);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe(
      "Gateway disconnected",
    );
    expect(container.querySelector("[role='status']")?.textContent).toBe(
      t("chat.errorCopyFallback"),
    );
    expect(container.querySelector("[role='status']")?.classList).not.toContain(
      "agent-chat__sr-only",
    );
  });
});
