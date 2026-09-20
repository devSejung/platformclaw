import { describe, expect, it } from "vitest";
import { platformClawMemoryTabFromLocation } from "./memory-page.ts";

describe("platformClawMemoryTabFromLocation", () => {
  it.each([
    ["/settings/memory", "", "", "memory"],
    ["/settings/memory/memories", "", "", "memory"],
    ["/settings/memory/wiki", "", "", "wiki"],
    ["/settings/memory/organization", "", "", "organization"],
    ["/settings/memory/dreams", "", "", "dreaming"],
    ["/platformclaw/app/settings/memory", "", "/platformclaw/app", "memory"],
    [
      "/platformclaw/app/settings/memory",
      "?__openclawMemoryPath=%2Fplatformclaw%2Fapp%2Fsettings%2Fmemory%2Fwiki",
      "/platformclaw/app",
      "wiki",
    ],
  ] as const)("maps %s%s with base %s to %s", (pathname, search, basePath, expected) => {
    expect(platformClawMemoryTabFromLocation({ pathname, search }, basePath)).toBe(expected);
  });
});
