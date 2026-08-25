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
      canUpdate: false,
      canInstall: false,
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
    expect(publish?.disabled).toBe(false);
    publish?.click();
    expect(onSkillHubPublishOpen).toHaveBeenCalledWith("repo-skill");
  });

  it("offers assigned-VM workspace publishing without showing bundled skills", () => {
    const container = document.createElement("div");
    const onSkillHubPublishOpen = vi.fn();
    const props = createProps({
      personalAccess: true,
      canUpdate: false,
      canInstall: false,
      skillHubConfig: { namespaces: ["engineering"], maxPackageBytes: 1024 },
      onSkillHubPublishOpen,
    });
    props.report = {
      ...expectDefined(props.report, "skills report"),
      executionTarget: "assigned_vm",
      skills: [createSkill({ source: "platformclaw-vm-workspace", skillKey: "vm-skill" })],
    };

    render(renderSkills(props), container);

    expect(normalizeText(container)).not.toContain("Search Skill Hub");
    expect(normalizeText(container)).toContain("Publish to Hub");
    const publish = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Publish to Hub"),
    );
    expect(publish?.disabled).toBe(false);
    publish?.click();
    expect(onSkillHubPublishOpen).toHaveBeenCalledWith("vm-skill");
  });

  it("keeps the assigned-VM publish dialog visible", () => {
    const container = document.createElement("div");
    const props = createProps({
      personalAccess: true,
      skillHubConfig: { namespaces: ["engineering"], maxPackageBytes: 1024 },
      skillHubPublishSkill: "vm-skill",
      skillHubPublishNamespace: "engineering",
    });
    props.report = {
      ...expectDefined(props.report, "skills report"),
      executionTarget: "assigned_vm",
      skills: [createSkill({ source: "platformclaw-vm-workspace", skillKey: "vm-skill" })],
    };

    render(renderSkills(props), container);

    expect(normalizeText(container)).toContain("Publish vm-skill");
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();
  });

  it("keeps a registry-success ownership warning visible after the publish dialog closes", () => {
    const container = document.createElement("div");
    render(
      renderSkills(
        createProps({
          skillHubMessage: {
            kind: "warning",
            text: "Published engineering/demo@1.0.0, but ownership review is required.",
          },
        }),
      ),
      container,
    );
    expect(normalizeText(container)).toContain("ownership review is required");
    expect(container.querySelector(".callout.warning")).not.toBeNull();
  });
});
