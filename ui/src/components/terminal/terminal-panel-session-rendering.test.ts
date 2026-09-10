import { describe, expect, it, vi } from "vitest";
import { updateTerminalSessionTextScale } from "./terminal-panel-session-rendering.ts";
import type { TerminalPanelSessionTab } from "./terminal-panel-session-types.ts";

describe("terminal session rendering", () => {
  it("updates the font size and refits every open terminal", () => {
    const terminal = { options: { fontSize: 11 } };
    const fit = vi.fn();
    const tabs = [{ controller: { terminal, fit } }] as unknown as TerminalPanelSessionTab[];

    updateTerminalSessionTextScale(tabs, 125);

    expect(terminal.options.fontSize).toBe(13.75);
    expect(fit).toHaveBeenCalledOnce();
  });
});
