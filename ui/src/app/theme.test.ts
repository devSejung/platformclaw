// @vitest-environment node
// Control UI tests cover theme behavior.
import { describe, expect, it, vi } from "vitest";
import { parseThemeSelection, resolveTheme } from "./theme.ts";

describe("resolveTheme", () => {
  it("resolves named theme families when mode is provided", () => {
    expect(resolveTheme("platformclaw", "light")).toBe("platformclaw-light");
    expect(resolveTheme("platformclaw", "dark")).toBe("platformclaw");
    expect(resolveTheme("knot", "dark")).toBe("openknot");
    expect(resolveTheme("dash", "light")).toBe("dash-light");
  });

  it("uses system preference when mode is system", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(resolveTheme("knot", "system")).toBe("openknot-light");
    vi.unstubAllGlobals();
  });
});

describe("parseThemeSelection", () => {
  it("falls back to defaults for unknown stored values", () => {
    expect(parseThemeSelection("fieldmanual", "invalid-mode")).toEqual({
      theme: "platformclaw",
      mode: "system",
    });
    expect(parseThemeSelection("platformclaw", "light")).toEqual({
      theme: "platformclaw",
      mode: "light",
    });
    expect(parseThemeSelection("dash", "light")).toEqual({
      theme: "dash",
      mode: "light",
    });
  });
});
