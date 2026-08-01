import { describe, expect, it } from "vitest";
import { skillsPageAllowedHubTabs } from "./skills-page.ts";

describe("Skills page plugin hub navigation", () => {
  it("keeps Workshop discoverable for personal agents on every execution target", () => {
    expect(skillsPageAllowedHubTabs("personal-agent")).toEqual(["skills", "workshop"]);
  });

  it("keeps the complete plugin hub for administrators", () => {
    expect(skillsPageAllowedHubTabs(undefined)).toBeUndefined();
  });
});
