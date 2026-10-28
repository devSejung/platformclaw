import { describe, expect, it } from "vitest";
import {
  skillHubScannerStatusLabel,
  skillHubVersionStatusLabel,
  skillHubVisibilityLabel,
} from "./labels.ts";

describe("Skill Hub policy labels", () => {
  it("explains sharing and nonblocking scan states without namespace policy", () => {
    expect(skillHubVisibilityLabel("PUBLIC")).toBe("Everyone at the company");
    expect(skillHubVisibilityLabel("SELECTED")).toBe("Selected recipients");
    expect(skillHubVisibilityLabel("PRIVATE")).toBe("Private");
    expect(skillHubScannerStatusLabel("warning")).toBe("Published with warnings");
    expect(skillHubScannerStatusLabel("unverified")).toBe("Unverified");
    expect(skillHubScannerStatusLabel("blocked")).toBe("Version blocked");
  });
  it("preserves an unknown upstream version status", () => {
    expect(skillHubVersionStatusLabel("FUTURE_STATUS")).toBe("FUTURE_STATUS");
  });
});
