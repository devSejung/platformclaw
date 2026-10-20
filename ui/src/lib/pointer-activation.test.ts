/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { wasPointerActivation } from "./pointer-activation.ts";

it("records the current activation before handlers, including assistive clicks after a pointer", () => {
  const button = document.createElement("button");
  const observed: boolean[] = [];
  button.addEventListener("click", () => observed.push(wasPointerActivation()));
  document.body.append(button);
  try {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(wasPointerActivation()).toBe(false);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    button.click();
    expect(observed).toEqual([true, true, false]);
  } finally {
    button.remove();
  }
});
