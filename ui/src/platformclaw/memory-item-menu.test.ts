/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "./memory-item-menu.ts";

type MemoryMenu = HTMLElement & {
  actions: ("share" | "delete")[];
  onAction: (action: "share" | "delete") => void;
  onClose: () => void;
  trigger: HTMLElement | null;
  updateComplete: Promise<unknown>;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("memory item action menu", () => {
  it("ignores an old dropdown finishing its hide after removal", async () => {
    const element = document.createElement("platformclaw-memory-item-menu") as MemoryMenu;
    element.onClose = vi.fn();
    document.body.append(element);
    await element.updateComplete;
    const dropdown = element.querySelector("wa-dropdown")!;
    element.remove();
    dropdown.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true }));
    expect(element.onClose).not.toHaveBeenCalled();
  });
  it.each(["share", "delete"] as const)("waits for explicit selection of %s", async (action) => {
    const element = document.createElement("platformclaw-memory-item-menu") as MemoryMenu;
    element.actions = ["share", "delete"];
    element.onAction = vi.fn();
    element.onClose = vi.fn();
    document.body.append(element);
    await element.updateComplete;
    expect(element.querySelectorAll("wa-dropdown-item")).toHaveLength(2);
    expect(element.onAction).not.toHaveBeenCalled();
    element.querySelector("wa-dropdown")!.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        cancelable: true,
        detail: { item: element.querySelector(`wa-dropdown-item[value="${action}"]`) },
      }),
    );
    expect(element.onAction).toHaveBeenCalledExactlyOnceWith(action);
    expect(element.onClose).toHaveBeenCalled();
  });

  it("dismisses with Escape without invoking the action and restores trigger focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const element = document.createElement("platformclaw-memory-item-menu") as MemoryMenu;
    element.trigger = trigger;
    element.onAction = vi.fn();
    element.onClose = vi.fn();
    document.body.append(element);
    await element.updateComplete;
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(element.onAction).not.toHaveBeenCalled();
    expect(element.onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });
});
