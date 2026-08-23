import { describe, expect, it } from "vitest";
import { resolveKnoxCommandText } from "./command-text.js";

describe("resolveKnoxCommandText", () => {
  it.each([
    ["/compact", "/compact"],
    ["metadata\n/skillhub list\n", "/skillhub list"],
    [
      "metadata\r\n@PlatformClaw /skillhub install release-notes\r\n",
      "/skillhub install release-notes",
    ],
  ])("extracts a standalone final-line command from %j", (input, expected) => {
    expect(resolveKnoxCommandText(input)).toBe(expected);
  });

  it.each([
    ["Please explain /compact", "Please explain /compact"],
    ["metadata\n@PlatformClaw hello", "@PlatformClaw hello"],
    ["/stop\nquoted: /stop", "quoted: /stop"],
  ])("uses only the final line for command detection in %j", (input, expected) => {
    expect(resolveKnoxCommandText(input)).toBe(expected);
  });
});
