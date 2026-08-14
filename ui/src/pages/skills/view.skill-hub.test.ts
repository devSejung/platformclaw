/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createProps, createSkill, normalizeText } from "./view.test-helpers.ts";
import { renderSkills } from "./view.ts";

describe("renderSkills Skill Hub publishing", () => {
  it("keeps workspace publishing on Skills and moves discovery to its own tab", () => {
    const container = document.createElement("div");
    const onSkillHubPublishOpen = vi.fn();
    const props = createProps({
      personalAccess: true,
      skillHubConfig: { namespaces: ["engineering"], maxPackageBytes: 1024 },
      onSkillHubPublishOpen,
    });
    props.report = {
      ...expectDefined(props.report, "skills report"),
      skills: [createSkill({ source: "openclaw-workspace", skillKey: "repo-skill" })],
    };

    render(renderSkills(props), container);

    expect(normalizeText(container)).not.toContain("Search Skill Hub");
    expect(normalizeText(container)).toContain("Publish to Hub");
    const publish = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Publish to Hub"),
    );
    publish?.click();
    expect(onSkillHubPublishOpen).toHaveBeenCalledWith("repo-skill");
  });

  it("does not offer server-side workspace publishing for an assigned VM skill", () => {
    const container = document.createElement("div");
    const props = createProps({
      personalAccess: true,
      skillHubConfig: { namespaces: ["engineering"], maxPackageBytes: 1024 },
    });
    props.report = {
      ...expectDefined(props.report, "skills report"),
      executionTarget: "assigned_vm",
      skills: [createSkill({ source: "platformclaw-vm-workspace", skillKey: "vm-skill" })],
    };

    render(renderSkills(props), container);

    expect(normalizeText(container)).not.toContain("Search Skill Hub");
    expect(normalizeText(container)).not.toContain("Publish to Hub");
  });
});
