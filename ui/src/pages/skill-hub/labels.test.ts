import { describe, expect, it } from "vitest";
import {
  skillHubScannerStatusLabel,
  skillHubScopeKindLabel,
  skillHubSkillStatusLabel,
  skillHubVersionStatusLabel,
  skillHubVisibilityLabel,
} from "./labels.ts";

describe("Skill Hub labels", () => {
  it("projects registry enums through the Control UI locale catalog", () => {
    expect(skillHubVisibilityLabel("NAMESPACE_ONLY")).toBe("Namespace only");
    expect(skillHubScopeKindLabel("part")).toBe("Part");
    expect(skillHubSkillStatusLabel("ACTIVE")).toBe("Active");
    expect(skillHubScannerStatusLabel("passed")).toBe("Scanner passed");
    expect(skillHubVersionStatusLabel("PENDING_REVIEW")).toBe("Pending review");
  });

  it("preserves unknown upstream statuses instead of inventing a label", () => {
    expect(skillHubSkillStatusLabel("FUTURE_STATUS")).toBe("FUTURE_STATUS");
    expect(skillHubVersionStatusLabel("FUTURE_STATUS")).toBe("FUTURE_STATUS");
  });
});
