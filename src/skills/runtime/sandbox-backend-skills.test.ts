import { describe, expect, it } from "vitest";
import {
  prepareSandboxBackendSkillEntries,
  resolveSandboxBackendSkillEligibility,
} from "./sandbox-backend-skills.js";

describe("sandbox backend skills", () => {
  it("prepares target-owned content and keeps the first precedence match", () => {
    const entries = prepareSandboxBackendSkillEntries({
      revision: "vm:1",
      eligibility: { bins: ["bash"], platforms: ["linux"] },
      files: [
        {
          source: "workspace",
          filePath: "/workspace/skills/demo/SKILL.md",
          content: "---\nname: demo\ndescription: Workspace demo\n---\nworkspace",
        },
        {
          source: "managed",
          filePath: "/opt/platformclaw/skills/demo/SKILL.md",
          content: "---\nname: demo\ndescription: Managed demo\n---\nmanaged",
        },
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.skill).toMatchObject({
      name: "demo",
      description: "Workspace demo",
      filePath: "/workspace/skills/demo/SKILL.md",
      readContent: expect.stringContaining("workspace"),
    });
    expect(entries[0]?.disableCommandDispatch).toBe(true);
  });

  it("uses backend platform and bins for requirement checks", () => {
    const catalog = {
      revision: "vm:1",
      files: [],
      eligibility: { bins: ["bash"], platforms: ["linux"] },
    };
    const eligibility = resolveSandboxBackendSkillEligibility(catalog);
    expect(eligibility?.platforms).toEqual(["linux"]);
    expect(eligibility?.hasBin("bash")).toBe(true);
    expect(eligibility?.hasBin("missing")).toBe(false);
  });

  it("keeps remote requirements but suppresses gateway-local install actions", () => {
    const entries = prepareSandboxBackendSkillEntries({
      revision: "vm:1",
      files: [
        {
          source: "managed",
          filePath: "/opt/platformclaw/skills/demo/SKILL.md",
          content:
            '---\nname: demo\ndescription: Managed demo\nmetadata: {"openclaw":{"requires":{"bins":["demo"]},"install":[{"id":"demo","kind":"node","package":"demo"}]}}\n---\n',
        },
      ],
    });

    expect(entries[0]?.metadata?.requires?.bins).toEqual(["demo"]);
    expect(entries[0]?.metadata?.install).toBeUndefined();
  });

  it("preserves dispatch and install metadata for a Gateway-owned remapped snapshot", () => {
    const entries = prepareSandboxBackendSkillEntries({
      revision: "gateway:1",
      owner: "gateway",
      files: [
        {
          source: "openclaw-managed",
          filePath: "/opt/platformclaw/skills/demo/SKILL.md",
          content:
            '---\nname: demo\ndescription: Managed demo\nmetadata: {"openclaw":{"install":[{"id":"demo","kind":"node","package":"demo"}]}}\n---\n',
        },
      ],
    });

    expect(entries[0]?.disableCommandDispatch).toBe(false);
    expect(entries[0]?.metadata?.install?.[0]?.package).toBe("demo");
  });
});
