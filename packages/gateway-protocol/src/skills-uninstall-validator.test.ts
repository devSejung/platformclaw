import { describe, expect, it } from "vitest";
import { validateSkillsUninstallParams } from "./index.js";

describe("skill uninstall protocol validator", () => {
  it("requires an exact target and revision", () => {
    expect(
      validateSkillsUninstallParams({
        agentId: "agent-1",
        slug: "demo-skill",
        destination: "sandbox-backend",
        backendTarget: "assigned_vm",
        expectedTargetRevision: 4,
        expectedSkillRevision: "sha256:0123456789abcdef",
      }),
    ).toBe(true);
    expect(
      validateSkillsUninstallParams({
        slug: "demo-skill",
        destination: "sandbox-backend",
      }),
    ).toBe(false);
    expect(
      validateSkillsUninstallParams({
        slug: "../demo-skill",
        destination: "workspace",
        expectedSkillRevision: "stale",
      }),
    ).toBe(false);
  });
});
