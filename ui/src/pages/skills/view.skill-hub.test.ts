/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createProps, createSkill, normalizeText } from "./view.test-helpers.ts";
import { renderSkills } from "./view.ts";

describe("renderSkills Skill Hub", () => {
  it("integrates search and workspace publishing for personal access", () => {
    const container = document.createElement("div");
    const onSkillHubDetailOpen = vi.fn();
    const onSkillHubPublishOpen = vi.fn();
    const props = createProps({
      personalAccess: true,
      skillHubConfig: { namespaces: ["engineering"], maxPackageBytes: 1024 },
      skillHubResults: [
        {
          namespace: "engineering",
          slug: "shared-skill",
          latestVersion: "2.0.0",
          summary: "Shared skill",
        },
      ],
      onSkillHubDetailOpen,
      onSkillHubPublishOpen,
    });
    props.report = {
      ...expectDefined(props.report, "skills report"),
      skills: [createSkill({ source: "openclaw-workspace", skillKey: "repo-skill" })],
    };

    render(renderSkills(props), container);

    expect(normalizeText(container)).toContain("engineering/shared-skill");
    expect(normalizeText(container)).toContain("Publish to Hub");
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    buttons.find((button) => button.textContent?.includes("Details"))?.click();
    buttons.find((button) => button.textContent?.includes("Publish to Hub"))?.click();
    expect(onSkillHubDetailOpen).toHaveBeenCalledWith("engineering", "shared-skill");
    expect(onSkillHubPublishOpen).toHaveBeenCalledWith("repo-skill");
  });
});
