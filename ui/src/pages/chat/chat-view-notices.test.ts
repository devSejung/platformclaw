import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { renderChatRunErrorNotice } from "./chat-view-notices.ts";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let container: HTMLDivElement;

beforeEach(() => {
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
      container,
    );
    const details = container.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("strong")?.textContent).toBe(error.split("\n")[0]);
    expect(container.querySelector(".chat-run-error__diagnostic")?.textContent).toBe(error);
    details.open = true;
    expect(details.querySelector("pre")?.getAttribute("tabindex")).toBe("0");
    container.querySelector<HTMLButtonElement>(`[aria-label="${t("chat.copyError")}"]`)!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(error));
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
    expect(container.querySelector("pre")?.textContent).toBe(error);
    expect(container.querySelector<HTMLButtonElement>(".chat-run-error__refresh")?.disabled).toBe(
      true,
    );
  });

  it("keeps a short error visible without requiring disclosure", () => {
    render(
      renderChatRunErrorNotice({ runError: { summary: "Gateway disconnected" }, connected: true }),
      container,
    );
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector(".chat-run-error__summary")?.textContent).toBe(
      "Gateway disconnected",
    );
    expect(container.querySelector(`[aria-label="${t("chat.copyError")}"]`)).not.toBeNull();
    expect(container.querySelector(".chat-run-error__refresh")).toBeNull();
  });
});
