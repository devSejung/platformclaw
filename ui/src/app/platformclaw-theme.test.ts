// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles/platformclaw-theme.css", import.meta.url), "utf8");

function themeTokens(theme: "platformclaw" | "platformclaw-light"): Map<string, string> {
  const selector = `:root[data-theme="${theme}"]`;
  const selectorIndex = css.indexOf(selector);
  expect(selectorIndex).toBeGreaterThanOrEqual(0);
  const blockStart = css.indexOf("{", selectorIndex);
  const blockEnd = css.indexOf("}", blockStart);
  const tokens = new Map<string, string>();
  for (const match of css.slice(blockStart + 1, blockEnd).matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name === undefined || value === undefined) {
      throw new Error(`Unexpected theme token declaration: ${match[0]}`);
    }
    tokens.set(name, value.trim());
  }
  return tokens;
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) {
    throw new Error(`Expected six-digit hex color, received ${hex}`);
  }
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error(`Expected three color channels, received ${hex}`);
  }
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("PlatformClaw theme contract", () => {
  it("maps design.md's canonical light palette exactly", () => {
    const tokens = themeTokens("platformclaw-light");
    expect(Object.fromEntries(tokens)).toMatchObject({
      bg: "#faf9f5",
      "bg-accent": "#f5f0e8",
      "bg-elevated": "#efe9de",
      "bg-hover": "#e8e0d2",
      card: "#efe9de",
      text: "#3d3d3a",
      "text-strong": "#141413",
      muted: "#6c6a64",
      border: "#e6dfd8",
      accent: "#0f7c72",
      primary: "#0f7c72",
      "primary-hover": "#0b625a",
      "primary-foreground": "#ffffff",
      "accent-2": "#d97757",
      danger: "#c64545",
      "radius-md": "8px",
      "radius-lg": "12px",
      "radius-xl": "16px",
    });
  });

  it("keeps product chrome charcoal in both color modes", () => {
    for (const theme of ["platformclaw", "platformclaw-light"] as const) {
      expect(Object.fromEntries(themeTokens(theme))).toMatchObject({
        "platformclaw-product-bg": "#181715",
        "platformclaw-product-bg-soft": "#1f1e1b",
        "platformclaw-product-bg-elevated": "#252320",
        "platformclaw-product-text": "#faf9f5",
        "platformclaw-product-muted": "#a09d96",
      });
    }
  });

  it("meets WCAG AA for normal text and primary controls", () => {
    const light = themeTokens("platformclaw-light");
    const dark = themeTokens("platformclaw");
    const pairs = [
      [light.get("text"), light.get("bg")],
      [light.get("muted"), light.get("bg")],
      [light.get("primary-foreground"), light.get("primary")],
      [dark.get("text"), dark.get("bg")],
      [dark.get("muted"), dark.get("bg")],
      [dark.get("accent"), dark.get("bg")],
      [dark.get("primary-foreground"), dark.get("primary")],
    ] as const;
    for (const [foreground, background] of pairs) {
      expect(foreground).toBeDefined();
      expect(background).toBeDefined();
      expect(contrastRatio(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
